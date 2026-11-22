//! Writing a document where the reader chooses.
//!
//! C22: the native reader could only write Markdown into its own library. This
//! module turns a document into Markdown, plain text, HTML, DOCX or JSON and puts it at any
//! path, atomically, refusing to replace a file the caller did not agree to
//! replace. Nothing here needs a window: `app.rs` asks for the path with the
//! system save panel and calls [`write_export_path`].
//!
//! - Markdown keeps both languages: the title, a heading per page, and every
//!   block as its quoted source with the translation under it; a block with no
//!   translation keeps its source and says it is not translated yet.
//! - Plain text keeps the translation alone, pages separated by a form feed.
//! - HTML is a self-contained text/geometry view. It does not claim image,
//!   vector, bookmark or hyperlink preservation because the native IR does not
//!   carry those source objects yet.
//! - DOCX is a real, minimal Office Open XML package containing text, formulas
//!   and tables. It is deliberately text-only and does not claim PDF fidelity.
//! - JSON keeps everything, as
//!   `{document, pages, blocks: [{id, page, type, source, translation,
//!   untranslated}]}`: a title, the page count, and every block with its 1-based
//!   page, so another tool can read one flat list without walking the document.
//!   A block without a translation carries `translation: null` and
//!   `untranslated: true`, so its source is the fallback and the flag says so.

use crate::i18n::{tr3, tr3_fill};
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

/// The plain-text page break: `\f`, the marker text tools have used for pages
/// since long before this program existed.
pub const PAGE_BREAK: char = '\u{c}';

/// The file forms an export can take.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExportFormat {
    /// The retained source PDF, copied byte-for-byte by the Save As action.
    Pdf,
    /// A new text-only PDF built from explicit translated block input.
    TranslatedPdf,
    /// Both languages, page by page: the form that loses nothing.
    Markdown,
    /// The translation alone.
    Text,
    /// A self-contained HTML reading view.
    Html,
    /// A minimal Office Open XML document with text, formulas and tables.
    Docx,
    /// The document as data.
    Json,
}

impl ExportFormat {
    /// The extension the save panel suggests for this form.
    pub fn extension(self) -> &'static str {
        match self {
            Self::Pdf => "pdf",
            Self::TranslatedPdf => "translated.pdf",
            Self::Markdown => "md",
            Self::Text => "txt",
            Self::Html => "html",
            Self::Docx => "docx",
            Self::Json => "json",
        }
    }

    /// The form a chosen path asks for: its extension decides, so the user does
    /// not have to choose a format in a dialog as well as a name.
    pub fn from_path(path: &Path) -> Self {
        let name = path.file_name().and_then(|name| name.to_str()).unwrap_or_default().to_ascii_lowercase();
        if name.ends_with(".translated.pdf") {
            return Self::TranslatedPdf;
        }
        path.extension().and_then(|extension| extension.to_str()).map_or(Self::Markdown, Self::from_extension)
    }

    /// The menu label: the format's own name, except plain text, which each
    /// interface language names for itself.
    pub fn label(self) -> &'static str {
        match self {
            Self::Pdf => tr3("原始 PDF", "Original PDF", "PDF gốc"),
            Self::TranslatedPdf => tr3("翻译 PDF", "Translated PDF", "PDF đã dịch"),
            Self::Markdown => "Markdown",
            Self::Text => tr3("纯文本", "Plain text", "Văn bản thuần"),
            Self::Html => "HTML",
            Self::Docx => "DOCX",
            Self::Json => "JSON",
        }
    }

    /// Case-insensitive, because Windows save panels upper-case extensions. A
    /// name with no extension, or one we do not write, becomes Markdown: the
    /// form that keeps both languages, rather than refusing the export after the
    /// user has already chosen a path.
    pub fn from_extension(extension: &str) -> Self {
        match extension.trim().trim_start_matches('.').to_ascii_lowercase().as_str() {
            "pdf" => Self::Pdf,
            "translated-pdf" | "translatedpdf" => Self::TranslatedPdf,
            "txt" | "text" => Self::Text,
            "html" | "htm" => Self::Html,
            "docx" => Self::Docx,
            "json" => Self::Json,
            _ => Self::Markdown,
        }
    }

    /// Whether this format can be generated from the native snapshot without
    /// pretending to be a translated-PDF writer.
    pub fn can_generate(self) -> bool { !matches!(self, Self::Pdf | Self::TranslatedPdf) }

    /// The preservation promise shown by provider/export UX and reports.
    pub fn preservation(self) -> &'static str {
        match self {
            Self::Pdf => "source bytes, fonts, images, vectors, bookmarks and hyperlinks preserved exactly",
            Self::TranslatedPdf => "new text-only PDF; source artwork and annotations are not preserved; standard Helvetica is not embedded",
            Self::Markdown | Self::Text | Self::Html | Self::Docx => "text, formulas, tables and native coordinates only; PDF objects are not preserved",
            Self::Json => "IR metadata, polygons, formulas and tables preserved; PDF objects are not embedded",
        }
    }
}

/// What a block is, so a consumer can tell a sentence from a preserved formula.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BlockKind {
    #[default]
    Text,
    /// A formula the reader never rewrites; its source is the formula itself.
    Formula,
    /// A structured table whose cells retain row/column spans.
    Table,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ExportCell {
    pub source: String,
    pub translation: Option<String>,
    pub row_span: u16,
    pub col_span: u16,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct ExportTable {
    pub rows: Vec<Vec<ExportCell>>,
}

impl ExportCell {
    pub fn new(source: impl Into<String>, translation: Option<String>) -> Self {
        Self { source: source.into(), translation, row_span: 1, col_span: 1 }
    }
}

/// One region of a page: its source and the translation when one exists.
#[derive(Clone, Debug, PartialEq)]
pub struct ExportBlock {
    pub id: String,
    pub kind: BlockKind,
    pub source: String,
    pub translation: Option<String>,
    pub polygon: Option<[[f32; 2]; 4]>,
    pub table: Option<ExportTable>,
}
impl ExportBlock {
    pub fn text(id: impl Into<String>, source: impl Into<String>, translation: Option<String>) -> Self {
        Self { id: id.into(), kind: BlockKind::Text, source: source.into(), translation, polygon: None, table: None }
    }

    pub fn with_polygon(mut self, polygon: [[f32; 2]; 4]) -> Self {
        self.polygon = Some(polygon);
        self
    }

    pub fn formula(id: impl Into<String>, latex: impl Into<String>) -> Self {
        Self { id: id.into(), kind: BlockKind::Formula, source: latex.into(), translation: None, polygon: None, table: None }
    }

    pub fn table(id: impl Into<String>, table: ExportTable) -> Self {
        Self { id: id.into(), kind: BlockKind::Table, source: String::new(), translation: None, polygon: None, table: Some(table) }
    }

    /// The translation when it says something: an empty string is a block that
    /// still needs translating, not a translation.
    pub fn translated_text(&self) -> Option<&str> {
        self.translation.as_deref().map(str::trim).filter(|text| !text.is_empty())
    }
}

/// One page: its blocks in reading order. Pages are numbered by their position,
/// so a block can never name a page its document does not have.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ExportPage {
    pub blocks: Vec<ExportBlock>,
}

/// The document an export renders: a title and pages of paired blocks.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ExportDocument {
    pub title: String,
    pub source_id: Option<String>,
    pub generation: Option<u64>,
    pub pages: Vec<ExportPage>,
}

impl ExportDocument {
    pub fn new(title: impl Into<String>) -> Self {
        Self { title: title.into(), source_id: None, generation: None, pages: Vec::new() }
    }

    /// One page holding the non-empty paragraphs of `text`, for a caller that
    /// holds flat text: a library record's body, or the page text the reader
    /// reports. Blocks are separated by a blank line, the one break every text
    /// form agrees on.
    pub fn from_text(title: impl Into<String>, text: &str) -> Self {
        let text = text.replace("\r\n", "\n");
        let blocks = text
            .split("\n\n")
            .map(str::trim)
            .filter(|paragraph| !paragraph.is_empty())
            .enumerate()
            .map(|(index, paragraph)| ExportBlock::text(format!("p1-b{}", index + 1), paragraph, None))
            .collect();
        let mut document = Self::new(title);
        document.push_page(blocks);
        document
    }

    pub fn push_page(&mut self, blocks: Vec<ExportBlock>) {
        self.pages.push(ExportPage { blocks });
    }
    pub fn set_identity(&mut self, source_id: impl Into<String>, generation: u64) {
        self.source_id = Some(source_id.into());
        self.generation = Some(generation);
    }

    /// Build the document from page-numbered groups: `pages` pairs a 0-based
    /// page position with the blocks the reader holds for it, so a page nobody
    /// held leaves a gap instead of shifting every later page down. Later entries
    /// for the same position are appended, in the order given.
    pub fn from_pages(title: impl Into<String>, pages: impl IntoIterator<Item = (usize, Vec<ExportBlock>)>) -> Self {
        let mut document = Self::new(title);
        let mut groups: Vec<(usize, Vec<ExportBlock>)> = pages.into_iter().collect();
        groups.sort_by_key(|(page, _)| *page);
        for (page, mut blocks) in groups {
            while document.pages.len() < page {
                document.push_page(Vec::new());
            }
            match document.pages.get_mut(page) {
                Some(existing) => existing.blocks.append(&mut blocks),
                None => document.push_page(blocks),
            }
        }
        document
    }

    /// Every block with its 1-based page, in document order.
    pub fn blocks(&self) -> impl Iterator<Item = (usize, &ExportBlock)> {
        self.pages.iter().enumerate().flat_map(|(index, page)| page.blocks.iter().map(move |block| (index + 1, block)))
    }

    pub fn block_count(&self) -> usize {
        self.blocks().count()
    }

    /// True when no page holds a block: there is nothing to write yet.
    pub fn is_empty(&self) -> bool {
        self.block_count() == 0
    }
}

/// The JSON document another tool reads. `pages` is the page count and every
/// block names the page it came from, so a reader of this file never has to
/// reconstruct the nesting.
#[derive(Debug, Deserialize, Serialize)]
struct JsonExport {
    document: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    source_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    generation: Option<u64>,
    pages: usize,
    blocks: Vec<JsonBlock>,
}

#[derive(Debug, Deserialize, PartialEq, Serialize)]
struct JsonBlock {
    id: String,
    page: usize,
    #[serde(rename = "type")]
    kind: BlockKind,
    source: String,
    translation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    polygon: Option<[[f32; 2]; 4]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    table: Option<ExportTable>,
    /// True when `translation` is null: the source is what this block falls back
    /// to, and a consumer that shows one side should say it is untranslated.
    untranslated: bool,
}

/// The document in the chosen form.
pub fn export_document(document: &ExportDocument, format: ExportFormat) -> String {
    match format {
        // PDF is handled by `write_export_bytes_path`: a text snapshot cannot
        // preserve the original PDF's objects, fonts or source hash.
        ExportFormat::Pdf | ExportFormat::TranslatedPdf | ExportFormat::Docx => String::new(),
        ExportFormat::Markdown => markdown(document),
        ExportFormat::Text => plain_text(document),
        ExportFormat::Html => html(document),
        ExportFormat::Json => json(document),
    }
}

/// The title a file carries when the document has none.
fn untitled() -> &'static str {
    tr3("文档", "Document", "Tài liệu")
}

fn title(document: &ExportDocument) -> &str {
    match document.title.trim() {
        "" => untitled(),
        title => title,
    }
}

/// `# title`, one `## page n` per page, then every block as its quoted source
/// with the translation under it: readable on its own, and a plain diff when the
/// translations change.
fn markdown(document: &ExportDocument) -> String {
    let mut out = format!("# {}\n", title(document));
    for (index, page) in document.pages.iter().enumerate() {
        out.push_str(&format!("\n## {}\n\n", tr3_fill("第 {} 页", "Page {}", "Trang {}", index + 1)));
        for block in &page.blocks {
            if let Some(table) = &block.table {
                for row in &table.rows {
                    out.push('|');
                    for cell in row { out.push(' '); out.push_str(&cell_text(cell).replace('|', "\\|")); out.push_str(" | "); }
                    out.push('\n');
                }
                out.push('\n');
                continue;
            }
            for line in block.source.trim().lines() {
                out.push_str("> ");
                out.push_str(line);
                out.push('\n');
            }
            out.push('\n');
            out.push_str(block.translated_text().unwrap_or(tr3("（尚未翻译）", "(not translated yet)", "(chưa dịch)")));
            out.push_str("\n\n");
        }
    }
    out
}

/// The translation alone, pages separated by a form feed. An untranslated block
/// contributes nothing: this form is the translated reading, and the JSON keeps
/// every source.
fn plain_text(document: &ExportDocument) -> String {
    let mut out = format!("{}\n", title(document));
    for (index, page) in document.pages.iter().enumerate() {
        if index > 0 {
            out.push(PAGE_BREAK);
            out.push('\n');
        }
        for block in &page.blocks {
            if let Some(table) = &block.table {
                let cells = table.rows.iter().flat_map(|row| row.iter().map(cell_text)).collect::<Vec<_>>().join(" | ");
                if !cells.is_empty() { out.push('\n'); out.push_str(&cells); out.push('\n'); }
                continue;
            }
            if let Some(translation) = block.translated_text() {
                out.push('\n');
                out.push_str(translation);
                out.push('\n');
            }
        }
    }
    out
}

fn json(document: &ExportDocument) -> String {
    let export = JsonExport {
        document: title(document).to_string(),
        source_id: document.source_id.clone(),
        generation: document.generation,
        pages: document.pages.len(),
        blocks: document
            .blocks()
            .map(|(page, block)| {
                let translation = block.translated_text().map(str::to_string);
                JsonBlock { id: block.id.clone(), page, kind: block.kind, source: block.source.clone(), translation: translation.clone(), polygon: block.polygon, table: block.table.clone(), untranslated: translation.is_none() }
            })
            .collect(),
    };
    // A string, a count and a list: serialising this cannot fail.
    serde_json::to_string_pretty(&export).unwrap_or_default()
}

/// Return bytes for every export that can be generated from a text snapshot.
/// PDF generation requires the source-byte and page-geometry contract in [`build_translated_pdf`].
pub fn export_document_bytes(document: &ExportDocument, format: ExportFormat) -> Result<Vec<u8>> {
    match format {
        ExportFormat::Pdf | ExportFormat::TranslatedPdf => anyhow::bail!("PDF output requires an explicit source or translated-PDF writer path."),
        ExportFormat::Docx => Ok(docx(document)),
        ExportFormat::Html => Ok(html(document).into_bytes()),
        ExportFormat::Markdown | ExportFormat::Text | ExportFormat::Json => Ok(export_document(document, format).into_bytes()),
    }
}

fn escape_xml(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&apos;")
}

fn escape_html(text: &str) -> String { escape_xml(text).replace('\n', "<br>") }

fn cell_text(cell: &ExportCell) -> String {
    cell.translation.as_deref().map(str::trim).filter(|text| !text.is_empty()).unwrap_or(cell.source.trim()).to_string()
}

fn html(document: &ExportDocument) -> String {
    let mut out = format!("<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>{}</title><style>body{{font:16px system-ui;max-width:900px;margin:2rem auto;line-height:1.5}}section{{break-after:page}}.source{{color:#555}}.translation{{margin:.25rem 0 1rem}}.formula{{font-family:ui-monospace}}table{{border-collapse:collapse;width:100%}}td,th{{border:1px solid #bbb;padding:.35rem;vertical-align:top}}</style></head><body><h1>{}</h1><p data-preservation=\"{}\">{}</p>", escape_html(title(document)), escape_html(title(document)), escape_html(ExportFormat::Html.preservation()), escape_html(ExportFormat::Html.preservation()));
    for (page_index, page) in document.pages.iter().enumerate() {
        out.push_str(&format!("<section data-page=\"{}\"><h2>{}</h2>", page_index + 1, escape_html(&tr3_fill("第 {} 页", "Page {}", "Trang {}", page_index + 1))));
        for block in &page.blocks {
            if let Some(table) = &block.table {
                out.push_str("<table><tbody>");
                for row in &table.rows {
                    out.push_str("<tr>");
                    for cell in row { out.push_str(&format!("<td rowspan=\"{}\" colspan=\"{}\">{}</td>", cell.row_span.max(1), cell.col_span.max(1), escape_html(&cell_text(cell)))); }
                    out.push_str("</tr>");
                }
                out.push_str("</tbody></table>");
                continue;
            }
            let class = if block.kind == BlockKind::Formula { "formula" } else { "" };
            out.push_str(&format!("<article id=\"{}\" class=\"{}\"><div class=\"source\">{}</div><div class=\"translation\">{}</div></article>", escape_html(&block.id), class, escape_html(&block.source), escape_html(block.translated_text().unwrap_or(tr3("（尚未翻译）", "(not translated yet)", "(chưa dịch)")))));
        }
        out.push_str("</section>");
    }
    out.push_str("</body></html>");
    out
}

fn docx_paragraph(text: &str, style: Option<&str>) -> String {
    let style = style.map(|name| format!("<w:pPr><w:pStyle w:val=\"{name}\"/></w:pPr>")).unwrap_or_default();
    format!("<w:p>{style}<w:r><w:t xml:space=\"preserve\">{}</w:t></w:r></w:p>", escape_xml(text))
}

fn docx_table(table: &ExportTable) -> String {
    let mut out = String::from("<w:tbl>");
    for row in &table.rows {
        out.push_str("<w:tr>");
        for cell in row { out.push_str(&format!("<w:tc><w:tcPr><w:gridSpan w:val=\"{}\"/></w:tcPr>{}</w:tc>", cell.col_span.max(1), docx_paragraph(&cell_text(cell), None))); }
        out.push_str("</w:tr>");
    }
    out.push_str("</w:tbl>");
    out
}

fn docx(document: &ExportDocument) -> Vec<u8> {
    let mut body = String::new();
    body.push_str(&docx_paragraph(title(document), Some("Title")));
    for (page_index, page) in document.pages.iter().enumerate() {
        body.push_str(&docx_paragraph(&tr3_fill("第 {} 页", "Page {}", "Trang {}", page_index + 1), Some("Heading1")));
        for block in &page.blocks {
            if let Some(table) = &block.table { body.push_str(&docx_table(table)); continue; }
            body.push_str(&docx_paragraph(&block.source, None));
            body.push_str(&docx_paragraph(block.translated_text().unwrap_or(tr3("（尚未翻译）", "(not translated yet)", "(chưa dịch)")), None));
        }
        if page_index + 1 < document.pages.len() { body.push_str("<w:p><w:r><w:br w:type=\"page\"/></w:r></w:p>"); }
    }
    let document_xml = format!("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:body>{body}<w:sectPr/></w:body></w:document>");
    let content_types = "<?xml version=\"1.0\" encoding=\"UTF-8\"?><Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Default Extension=\"xml\" ContentType=\"application/xml\"/><Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/></Types>";
    let rels = "<?xml version=\"1.0\" encoding=\"UTF-8\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"word/document.xml\"/></Relationships>";
    zip_store(&[("[Content_Types].xml", content_types.as_bytes().to_vec()), ("_rels/.rels", rels.as_bytes().to_vec()), ("word/document.xml", document_xml.into_bytes())])
}

fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = 0xffff_ffff;
    for byte in bytes { crc ^= u32::from(*byte); for _ in 0..8 { crc = if crc & 1 == 1 { (crc >> 1) ^ 0xedb8_8320 } else { crc >> 1 }; } }
    !crc
}

fn zip_store(entries: &[(&str, Vec<u8>)]) -> Vec<u8> {
    let mut out = Vec::new(); let mut central = Vec::new();
    for (name, data) in entries {
        let offset = out.len() as u32; let name = name.as_bytes(); let size = data.len() as u32; let crc = crc32(data);
        out.extend_from_slice(&0x04034b50u32.to_le_bytes()); out.extend_from_slice(&20u16.to_le_bytes()); out.extend_from_slice(&0u16.to_le_bytes()); out.extend_from_slice(&0u16.to_le_bytes()); out.extend_from_slice(&0u16.to_le_bytes()); out.extend_from_slice(&0u16.to_le_bytes()); out.extend_from_slice(&crc.to_le_bytes()); out.extend_from_slice(&size.to_le_bytes()); out.extend_from_slice(&size.to_le_bytes()); out.extend_from_slice(&(name.len() as u16).to_le_bytes()); out.extend_from_slice(&0u16.to_le_bytes()); out.extend_from_slice(name); out.extend_from_slice(data);
        central.extend_from_slice(&0x02014b50u32.to_le_bytes()); central.extend_from_slice(&20u16.to_le_bytes()); central.extend_from_slice(&20u16.to_le_bytes()); central.extend_from_slice(&0u16.to_le_bytes()); central.extend_from_slice(&0u16.to_le_bytes()); central.extend_from_slice(&0u16.to_le_bytes()); central.extend_from_slice(&0u16.to_le_bytes()); central.extend_from_slice(&crc.to_le_bytes()); central.extend_from_slice(&size.to_le_bytes()); central.extend_from_slice(&size.to_le_bytes()); central.extend_from_slice(&(name.len() as u16).to_le_bytes()); central.extend_from_slice(&0u16.to_le_bytes()); central.extend_from_slice(&0u16.to_le_bytes()); central.extend_from_slice(&0u16.to_le_bytes()); central.extend_from_slice(&0u16.to_le_bytes()); central.extend_from_slice(&0u32.to_le_bytes()); central.extend_from_slice(&offset.to_le_bytes()); central.extend_from_slice(name);
    }
    let central_offset = out.len() as u32; out.extend_from_slice(&central); out.extend_from_slice(&0x06054b50u32.to_le_bytes()); out.extend_from_slice(&0u16.to_le_bytes()); out.extend_from_slice(&0u16.to_le_bytes()); out.extend_from_slice(&(entries.len() as u16).to_le_bytes()); out.extend_from_slice(&(entries.len() as u16).to_le_bytes()); out.extend_from_slice(&(central.len() as u32).to_le_bytes()); out.extend_from_slice(&central_offset.to_le_bytes()); out.extend_from_slice(&0u16.to_le_bytes()); out
}

/// Write `content` as `dir/name` and return the path written.
///
/// Missing parent folders are created. An existing file is refused unless
/// `overwrite` says the caller agreed to replace it: a save panel has already
/// asked the user, a scripted caller has not. The bytes go to a temporary file
/// in the same folder and are renamed into place, so a failed export never
/// leaves half a document at the chosen path, and a reader of that path never
/// sees a partial file.
pub fn write_export(dir: &Path, name: &str, content: &str, overwrite: bool) -> Result<PathBuf> {
    let name = name.trim();
    anyhow::ensure!(!name.is_empty(), "{}", tr3("请输入文件名。", "Enter a file name.", "Hãy nhập tên tệp."));
    anyhow::ensure!(!name.contains(['/', '\\']) && name != "." && name != "..", "{}", tr3("文件名不能包含路径。", "A file name cannot contain a folder.", "Tên tệp không được chứa đường dẫn."));
    std::fs::create_dir_all(dir).with_context(|| tr3_fill("无法创建目录 {}", "Cannot create the folder {}", "Không tạo được thư mục {}", dir.display()))?;
    let target = dir.join(name);
    anyhow::ensure!(overwrite || !target.exists(), "{}", tr3_fill("已存在同名文件，未覆盖：{}", "A file with this name already exists and was not replaced: {}", "Đã có tệp cùng tên, không ghi đè: {}", target.display()));
    let temp = Temp::new(dir, name);
    write_temp(&temp.path, content.as_bytes())?;
    publish_temp(&temp.path, &target, overwrite)?;
    Ok(target)
}

/// Write `content` where a save panel pointed: the last segment is the name, the
/// folder comes from the path.
pub fn write_export_path(path: &Path, content: &str, overwrite: bool) -> Result<PathBuf> {
    let name = path.file_name().map(|name| name.to_string_lossy().into_owned()).context(tr3("请选择文件名。", "Choose a file name.", "Hãy chọn tên tệp."))?;
    let dir = path.parent().filter(|dir| !dir.as_os_str().is_empty()).unwrap_or_else(|| Path::new("."));
    write_export(dir, &name, content, overwrite)
}

/// Write already-serialized bytes where a Save As panel pointed.
/// PDF Save As preserves the retained source bytes, fonts and source hash.
pub fn write_export_bytes_path(path: &Path, bytes: &[u8], overwrite: bool) -> Result<PathBuf> {
    let name = path.file_name().map(|name| name.to_string_lossy().into_owned()).context(tr3("请选择文件名。", "Choose a file name.", "Hãy chọn tên tệp."))?;
    let dir = path.parent().filter(|dir| !dir.as_os_str().is_empty()).unwrap_or_else(|| Path::new("."));
    anyhow::ensure!(!name.trim().is_empty() && !name.contains(['/', '\\']) && name != "." && name != "..", "{}", tr3("文件名无效。", "The file name is invalid.", "Tên tệp không hợp lệ."));
    std::fs::create_dir_all(dir).with_context(|| tr3_fill("无法创建目录 {}", "Cannot create the folder {}", "Không tạo được thư mục {}", dir.display()))?;
    let target = dir.join(&name);
    anyhow::ensure!(overwrite || !target.exists(), "{}", tr3_fill("已存在同名文件，未覆盖：{}", "A file with this name already exists and was not replaced: {}", "Đã có tệp cùng tên, không ghi đè: {}", target.display()));
    let temporary = dir.join(format!(".{name}.{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| -> Result<PathBuf> {
        write_temp(&temporary, bytes)?;
        publish_temp(&temporary, &target, overwrite)?;
        Ok(target)
    })();
    if result.is_err() { let _ = std::fs::remove_file(&temporary); }
    result
}

fn write_temp(path: &Path, bytes: &[u8]) -> Result<()> {
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(path)
        .with_context(|| tr3_fill("无法写入 {}", "Cannot write {}", "Không ghi được {}", path.display()))?;
    file.write_all(bytes).with_context(|| tr3_fill("无法写入 {}", "Cannot write {}", "Không ghi được {}", path.display()))
}

fn publish_temp(temporary: &Path, target: &Path, overwrite: bool) -> Result<()> {
    if overwrite {
        if target.exists() { std::fs::remove_file(target).with_context(|| tr3_fill("无法替换 {}", "Cannot replace {}", "Không thay được {}", target.display()))?; }
        std::fs::rename(temporary, target).with_context(|| tr3_fill("无法写入 {}", "Cannot write {}", "Không ghi được {}", target.display()))
    } else {
        // A same-directory hard link publishes atomically and fails if another
        // writer created the destination after the initial existence check.
        std::fs::hard_link(temporary, target).with_context(|| tr3_fill("无法写入 {}", "Cannot write {}", "Không ghi được {}", target.display()))?;
        std::fs::remove_file(temporary).with_context(|| tr3_fill("无法写入 {}", "Cannot write {}", "Không ghi được {}", temporary.display()))
    }
}

/// The name the save panel starts with: the title as a file name, plus the
/// extension of `format`.
pub fn suggested_name(title: &str, format: ExportFormat) -> String {
    format!("{}.{}", file_stem(title), format.extension())
}

/// A title that can be one file name: the characters Windows refuses (and the
/// two path separators) become `_`, whitespace collapses, leading and trailing
/// dots and spaces go because Windows drops them silently, the stem is bounded,
/// and nothing left becomes "document".
pub fn file_stem(title: &str) -> String {
    let replaced: String = title.chars().map(|ch| if ch.is_control() || "/\\:*?\"<>|".contains(ch) { '_' } else { ch }).collect();
    let collapsed = replaced.split_whitespace().collect::<Vec<_>>().join(" ");
    let stem: String = collapsed.trim_matches([' ', '.']).chars().take(120).collect();
    if stem.trim().is_empty() { tr3("文档", "document", "tài liệu").to_string() } else { stem }
}

/// Explicit source mapping and page geometry for an independently generated
/// translated PDF. Coordinates are PDF points with a top-left origin, matching
/// the native reader's page-space boxes. This output is a text-only document;
/// it does not preserve source page artwork or annotations.
#[derive(Clone, Debug, PartialEq)]
pub struct TranslatedPdfBlock {
    pub id: String,
    pub source: String,
    pub translation: Option<String>,
    pub rect: [[f32; 2]; 4],
}

#[derive(Clone, Debug, PartialEq)]
pub struct TranslatedPdfPage {
    pub source_id: String,
    pub page_number: usize,
    pub width: f32,
    pub height: f32,
    pub blocks: Vec<TranslatedPdfBlock>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct TranslatedPdfInput {
    pub title: String,
    pub source_id: String,
    pub source_sha256: [u8; 32],
    pub source_path: Option<PathBuf>,
    pub pages: Vec<TranslatedPdfPage>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TranslatedPdfOutput {
    pub bytes: Vec<u8>,
    pub warnings: Vec<String>,
    pub missing_translation_blocks: Vec<String>,
}

/// Build a new bilingual text-only PDF from an explicit source snapshot.
///
/// The source bytes are only read to verify identity and are never changed or
/// copied into this new artifact. The writer uses PDF's built-in Helvetica
/// (not embedded), supports Windows-1252 text only, and refuses overflow rather
/// than silently dropping text. Callers must surface returned warnings.
pub fn build_translated_pdf(
    source_pdf: &[u8],
    input: &TranslatedPdfInput,
) -> Result<TranslatedPdfOutput> {
    anyhow::ensure!(
        source_pdf.starts_with(b"%PDF-"),
        "source identity is not a PDF"
    );
    let source_digest: [u8; 32] = Sha256::digest(source_pdf).into();
    anyhow::ensure!(
        source_digest == input.source_sha256,
        "source PDF hash does not match the translated snapshot"
    );
    anyhow::ensure!(
        !input.source_id.trim().is_empty(),
        "source identity is required"
    );
    anyhow::ensure!(
        input.title.chars().all(|ch| win_1252_byte(ch).is_some()),
        "PDF title contains characters not supported by standard Helvetica/Windows-1252"
    );
    anyhow::ensure!(
        !input.pages.is_empty(),
        "translated PDF needs at least one mapped source page"
    );

    let mut seen = std::collections::HashSet::new();
    let mut streams = Vec::with_capacity(input.pages.len());
    let mut missing = Vec::new();
    for (page_index, page) in input.pages.iter().enumerate() {
        anyhow::ensure!(
            page.source_id == input.source_id,
            "page {} maps to a different source identity",
            page_index + 1
        );
        anyhow::ensure!(
            page.page_number == page_index + 1,
            "page mapping must be complete, ordered, and 1-based (expected {}, got {})",
            page_index + 1,
            page.page_number
        );
        anyhow::ensure!(
            page.width.is_finite()
                && page.height.is_finite()
                && page.width > 0.0
                && page.height > 0.0,
            "page {} has invalid dimensions",
            page.page_number
        );
        let mut content = String::new();
        for block in &page.blocks {
            anyhow::ensure!(
                !block.id.trim().is_empty() && seen.insert(block.id.as_str()),
                "block ids must be non-empty and unique across the document"
            );
            let rect = validate_block_rect(block, page)?;
            let translated = block
                .translation
                .as_deref()
                .map(str::trim)
                .filter(|text| !text.is_empty());
            if translated.is_none() {
                missing.push(block.id.clone());
            }
            let target = translated.unwrap_or("[Translation unavailable]");
            let source_lines = wrap_pdf_text(&block.source, rect.2, 9.0)?;
            let target_lines = wrap_pdf_text(target, rect.2, 9.0)?;
            let line_count = source_lines.len() + target_lines.len();
            anyhow::ensure!(
                line_count > 0,
                "block {} has no source or translation text",
                block.id
            );
            let line_height = 11.0_f32;
            let required_lines = line_count + 2;
            anyhow::ensure!(
                required_lines as f32 * line_height <= rect.3,
                "layout overflow in block {}: {} lines need {:.1}pt but box is {:.1}pt",
                block.id,
                required_lines,
                required_lines as f32 * line_height,
                rect.3
            );
            let mut y = page.height - rect.1 - 10.0;
            push_pdf_text(&mut content, rect.0, y, "Source:", 8.0)?;
            y -= line_height;
            for line in source_lines {
                push_pdf_text(&mut content, rect.0, y, &line, 9.0)?;
                y -= line_height;
            }
            push_pdf_text(&mut content, rect.0, y, "Translation:", 8.0)?;
            y -= line_height;
            for line in target_lines {
                push_pdf_text(&mut content, rect.0, y, &line, 9.0)?;
                y -= line_height;
            }
        }
        streams.push(content.into_bytes());
    }
    let bytes = serialize_text_pdf(&input.title, &input.pages, &streams)?;
    Ok(TranslatedPdfOutput {
        bytes,
        warnings: vec!["font-not-embedded: output uses the PDF standard Helvetica font; portability is limited to Windows-1252 glyphs".into()],
        missing_translation_blocks: missing,
    })
}

fn validate_block_rect(
    block: &TranslatedPdfBlock,
    page: &TranslatedPdfPage,
) -> Result<(f32, f32, f32, f32)> {
    let points = block.rect;
    anyhow::ensure!(
        points.iter().flatten().all(|value| value.is_finite()),
        "block {} has non-finite geometry",
        block.id
    );
    let left = points
        .iter()
        .map(|point| point[0])
        .fold(f32::INFINITY, f32::min);
    let right = points
        .iter()
        .map(|point| point[0])
        .fold(f32::NEG_INFINITY, f32::max);
    let top = points
        .iter()
        .map(|point| point[1])
        .fold(f32::INFINITY, f32::min);
    let bottom = points
        .iter()
        .map(|point| point[1])
        .fold(f32::NEG_INFINITY, f32::max);
    anyhow::ensure!(
        right > left
            && bottom > top
            && left >= 0.0
            && top >= 0.0
            && right <= page.width
            && bottom <= page.height,
        "block {} geometry is empty or outside page {}",
        block.id,
        page.page_number
    );
    let expected = [[left, top], [right, top], [right, bottom], [left, bottom]];
    anyhow::ensure!(
        points == expected,
        "block {} geometry must be an ordered axis-aligned rectangle",
        block.id
    );
    Ok((left, top, right - left, bottom - top))
}

fn wrap_pdf_text(text: &str, width: f32, font_size: f32) -> Result<Vec<String>> {
    anyhow::ensure!(
        text.chars().all(|ch| win_1252_byte(ch).is_some()),
        "translated PDF text contains characters not supported by standard Helvetica/Windows-1252"
    );
    let mut lines = Vec::new();
    let mut line = String::new();
    let mut line_width = 0.0_f32;
    let max_width = width.max(1.0);
    for word in text.split_whitespace() {
        let word_width = word.chars().count() as f32 * font_size * 0.52;
        anyhow::ensure!(
            word_width <= max_width,
            "layout failure: unbreakable word is wider than its block"
        );
        let next_width = if line.is_empty() {
            word_width
        } else {
            line_width + font_size * 0.52 + word_width
        };
        if !line.is_empty() && next_width > max_width {
            lines.push(std::mem::take(&mut line));
            line_width = 0.0;
        }
        if !line.is_empty() {
            line.push(' ');
            line_width += font_size * 0.52;
        }
        line.push_str(word);
        line_width += word_width;
    }
    if !line.is_empty() {
        lines.push(line);
    }
    Ok(lines)
}

fn win_1252_byte(ch: char) -> Option<u8> {
    let code = ch as u32;
    if (0x20..=0x7e).contains(&code) || (0xa0..=0xff).contains(&code) {
        return Some(code as u8);
    }
    Some(match ch {
        '€' => 0x80,
        '‚' => 0x82,
        'ƒ' => 0x83,
        '„' => 0x84,
        '…' => 0x85,
        '†' => 0x86,
        '‡' => 0x87,
        'ˆ' => 0x88,
        '‰' => 0x89,
        'Š' => 0x8a,
        '‹' => 0x8b,
        'Œ' => 0x8c,
        'Ž' => 0x8e,
        '‘' => 0x91,
        '’' => 0x92,
        '“' => 0x93,
        '”' => 0x94,
        '•' => 0x95,
        '–' => 0x96,
        '—' => 0x97,
        '˜' => 0x98,
        '™' => 0x99,
        'š' => 0x9a,
        '›' => 0x9b,
        'œ' => 0x9c,
        'ž' => 0x9e,
        'Ÿ' => 0x9f,
        _ => return None,
    })
}

fn push_pdf_text(content: &mut String, x: f32, y: f32, text: &str, size: f32) -> Result<()> {
    let mut encoded = String::new();
    for ch in text.chars() {
        let byte = win_1252_byte(ch)
            .context("font encoding failure: text is not representable in Windows-1252")?;
        if matches!(byte, b'(' | b')' | b'\\') {
            encoded.push('\\');
        }
        if byte < 0x20 || byte > 0x7e {
            encoded.push_str(&format!("\\{:03o}", byte));
        } else {
            encoded.push(byte as char);
        }
    }
    content.push_str(&format!(
        "BT /F1 {size:.2} Tf 1 0 0 1 {x:.2} {y:.2} Tm ({encoded}) Tj ET\n"
    ));
    Ok(())
}

fn pdf_literal(text: &str) -> String {
    text.chars()
        .filter_map(win_1252_byte)
        .map(|byte| {
            if matches!(byte, b'(' | b')' | b'\\') {
                format!("\\{}", byte as char)
            } else if byte < 0x20 || byte > 0x7e {
                format!("\\{:03o}", byte)
            } else {
                (byte as char).to_string()
            }
        })
        .collect()
}

fn serialize_text_pdf(
    title: &str,
    pages: &[TranslatedPdfPage],
    streams: &[Vec<u8>],
) -> Result<Vec<u8>> {
    let mut objects = vec![Vec::new(); 4 + pages.len() * 2];
    objects[1] = b"<< /Type /Catalog /Pages 2 0 R >>".to_vec();
    let kids = (0..pages.len())
        .map(|index| format!("{} 0 R", 4 + index * 2))
        .collect::<Vec<_>>()
        .join(" ");
    objects[2] = format!("<< /Type /Pages /Count {} /Kids [{}] >>", pages.len(), kids).into_bytes();
    objects[3] =
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"
            .to_vec();
    for (index, (page, stream)) in pages.iter().zip(streams).enumerate() {
        let page_object = 4 + index * 2;
        let stream_object = page_object + 1;
        objects[page_object] = format!("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {:.2} {:.2}] /Resources << /Font << /F1 3 0 R >> >> /Contents {} 0 R >>", page.width, page.height, stream_object).into_bytes();
        let mut value = format!("<< /Length {} >>\nstream\n", stream.len()).into_bytes();
        value.extend_from_slice(stream);
        value.extend_from_slice(b"endstream");
        objects[stream_object] = value;
    }
    let mut bytes = b"%PDF-1.4\n%\xE2\xE3\xCF\xD3\n".to_vec();
    let mut offsets = vec![0usize; objects.len()];
    for index in 1..objects.len() {
        offsets[index] = bytes.len();
        bytes.extend_from_slice(format!("{index} 0 obj\n").as_bytes());
        bytes.extend_from_slice(&objects[index]);
        bytes.extend_from_slice(b"\nendobj\n");
    }
    let xref = bytes.len();
    bytes.extend_from_slice(format!("xref\n0 {}\n0000000000 65535 f \n", objects.len()).as_bytes());
    for offset in offsets.iter().skip(1) {
        bytes.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
    }
    bytes.extend_from_slice(format!("trailer\n<< /Size {} /Root 1 0 R /Info << /Title ({}) >> >>\nstartxref\n{xref}\n%%EOF\n", objects.len(), pdf_literal(title)).as_bytes());
    Ok(bytes)
}

/// Atomically write a translated PDF artifact, checking cancellation both before
/// and after staging. Cancellation removes the staged file and never publishes.
pub fn write_translated_pdf_path(
    source_pdf: &[u8],
    input: &TranslatedPdfInput,
    path: &Path,
    cancelled: &std::sync::atomic::AtomicBool,
) -> Result<TranslatedPdfOutput> {
    use std::sync::atomic::Ordering;
    if let Some(source_path) = input.source_path.as_ref() {
        if let (Ok(target), Ok(source)) = (path.canonicalize(), source_path.canonicalize()) {
            anyhow::ensure!(
                target != source,
                "translated output must not overwrite the retained source PDF"
            );
        }
    }
    anyhow::ensure!(
        !cancelled.load(Ordering::Acquire),
        "translated PDF export cancelled"
    );
    let output = build_translated_pdf(source_pdf, input)?;
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .context("choose an output file name")?;
    let dir = path
        .parent()
        .filter(|dir| !dir.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(dir)?;
    anyhow::ensure!(
        path.extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| ext.eq_ignore_ascii_case("pdf")),
        "translated PDF output path must end in .pdf"
    );
    let target = dir.join(&name);
    anyhow::ensure!(
        !target.exists(),
        "translated PDF destination already exists and overwrite is not supported safely: {}",
        target.display()
    );
    let temporary = dir.join(format!(".{name}.{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| -> Result<()> {
        write_temp(&temporary, &output.bytes)?;
        publish_translated_temp(&temporary, &target, cancelled)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result?;
    Ok(output)
}

fn publish_translated_temp(
    temporary: &Path,
    target: &Path,
    cancelled: &std::sync::atomic::AtomicBool,
) -> Result<()> {
    use std::sync::atomic::Ordering;
    anyhow::ensure!(
        !cancelled.load(Ordering::Acquire),
        "translated PDF export cancelled"
    );
    std::fs::hard_link(temporary, target)
        .with_context(|| format!("cannot publish translated PDF {}", target.display()))?;
    std::fs::remove_file(temporary).with_context(|| {
        format!(
            "cannot remove staged translated PDF {}",
            temporary.display()
        )
    })
}

/// The half-written file: removed when this drops, so a failure never leaves a
/// stray `.tmp` beside the user's document. A successful rename moves it away, so
/// the removal is then a no-op.
struct Temp {
    path: PathBuf,
}

impl Temp {
    fn new(dir: &Path, name: &str) -> Self {
        Self { path: dir.join(format!(".{name}.{}.tmp", uuid::Uuid::new_v4())) }
    }
}

impl Drop for Temp {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A small document: a title, two pages, one translated block and one still
    /// waiting for its translation.
    fn sample() -> ExportDocument {
        let mut document = ExportDocument::new("Quarterly report");
        document.push_page(vec![ExportBlock::text("p1-b1", "Revenue rose", Some("Doanh thu tăng".into())), ExportBlock::text("p1-b2", "Costs fell", None)]);
        document.push_page(vec![ExportBlock::text("p2-b1", "Outlook", Some("Triển vọng".into()))]);
        document
    }

    /// The same two pages assembled the way `app.rs` hands the reader's page
    /// blocks to the exporter.
    fn assembled() -> ExportDocument {
        ExportDocument::from_pages(
            "Quarterly report",
            [
                (0, vec![ExportBlock::text("p1-r1", "Revenue rose", Some("Doanh thu tăng".into()))]),
                (1, vec![ExportBlock::text("p2-r1", "Outlook", None)]),
            ],
        )
    }

    /// A throwaway folder. Tests remove it themselves; a panic leaves only the
    /// operating system's temporary folder to clean.
    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pdf-workspace-export-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("create a temporary folder");
        dir
    }

    fn files(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir).expect("read the folder").filter_map(|entry| entry.ok()).map(|entry| entry.file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        names
    }

    fn page_heading(page: usize) -> String {
        tr3_fill("第 {} 页", "Page {}", "Trang {}", page)
    }

    #[test]
    fn markdown_has_a_title_a_heading_per_page_and_paired_lines() {
        let text = export_document(&sample(), ExportFormat::Markdown);
        assert!(text.starts_with("# Quarterly report\n"));
        assert!(text.contains(&format!("## {}", page_heading(1))));
        assert!(text.contains(&format!("## {}", page_heading(2))));
        // The source is quoted, the translation sits under it, and a block
        // without one says so instead of disappearing.
        assert!(text.contains("> Revenue rose\n\nDoanh thu tăng"), "{text}");
        let untranslated = tr3("（尚未翻译）", "(not translated yet)", "(chưa dịch)");
        assert!(text.contains(&format!("> Costs fell\n\n{untranslated}")), "{text}");
        // Page two follows page one, and its block sits under its own heading.
        assert!(text.find(&page_heading(2)) > text.find("> Revenue rose"));
        assert!(text.find("> Outlook") > text.find(&page_heading(2)));
    }

    #[test]
    fn plain_text_keeps_the_translation_only_and_marks_each_page_break() {
        assert_eq!(PAGE_BREAK, '\u{c}');
        let text = export_document(&sample(), ExportFormat::Text);
        assert!(text.starts_with("Quarterly report"));
        assert!(text.contains("Doanh thu tăng"));
        assert!(text.contains("Triển vọng"));
        assert!(!text.contains("Revenue rose"), "the plain text is the translation alone: {text:?}");
        assert!(!text.contains("Costs fell"), "an untranslated block has no translated text to write: {text:?}");
        assert_eq!(text.matches(PAGE_BREAK).count(), 1, "two pages have one break between them: {text:?}");
        assert!(text.find(PAGE_BREAK) < text.find("Triển vọng"), "the break comes before the second page: {text:?}");
    }

    #[test]
    fn json_carries_the_document_its_pages_and_every_block() {
        let text = export_document(&sample(), ExportFormat::Json);
        let parsed: JsonExport = serde_json::from_str(&text).expect("the export is JSON");
        assert_eq!(parsed.document, "Quarterly report");
        assert_eq!(parsed.pages, 2);
        assert_eq!(parsed.blocks.len(), 3);
        assert_eq!(parsed.blocks[0], JsonBlock { id: "p1-b1".into(), page: 1, kind: BlockKind::Text, source: "Revenue rose".into(), translation: Some("Doanh thu tăng".into()), polygon: None, table: None, untranslated: false });
        assert_eq!(parsed.blocks[1].translation, None, "an untranslated block is exported, without a translation");
        assert!(parsed.blocks[1].untranslated, "and it is marked as untranslated");
        assert_eq!(parsed.blocks[2].page, 2, "each block names its own page");
        assert!(text.contains("\"type\": \"text\""), "a consumer reads the block type from the key named type: {text}");
    }

    #[test]
    fn format_capabilities_and_binary_exports_are_truthful() {
        assert!(!ExportFormat::Pdf.can_generate());
        assert!(!ExportFormat::TranslatedPdf.can_generate(), "translated PDF requires the explicit source-mapped writer");
        assert!(ExportFormat::Docx.can_generate() && ExportFormat::Html.can_generate());
        assert!(ExportFormat::Pdf.preservation().contains("preserved exactly"));
        assert!(ExportFormat::Docx.preservation().contains("not preserved"));
        assert!(export_document_bytes(&sample(), ExportFormat::Pdf).is_err());
        let html = export_document_bytes(&sample(), ExportFormat::Html).expect("HTML export");
        assert!(html.starts_with(b"<!doctype html>"));
        assert!(String::from_utf8_lossy(&html).contains("Revenue rose"));
        let docx = export_document_bytes(&sample(), ExportFormat::Docx).expect("DOCX export");
        assert!(docx.starts_with(b"PK\x03\x04"), "DOCX must be a ZIP package");
        assert!(docx.windows(b"[Content_Types].xml".len()).any(|window| window == b"[Content_Types].xml"));
    }

    #[test]
    fn tables_and_formulas_survive_structured_exports() {
        let table = ExportTable { rows: vec![vec![ExportCell::new("Revenue", Some("Doanh thu".into())), ExportCell::new("x^2", Some("x²".into()))]] };
        let document = ExportDocument::from_pages("Structured", [(1, vec![ExportBlock::formula("formula", "E=mc^2"), ExportBlock::table("table", table)])]);
        let markdown = export_document(&document, ExportFormat::Markdown);
        assert!(markdown.contains("E=mc^2") && markdown.contains("Doanh thu") && markdown.contains("x²"));
        let json = export_document(&document, ExportFormat::Json);
        assert!(json.contains("formula") && json.contains("table") && json.contains("row_span"));
        let docx = export_document_bytes(&document, ExportFormat::Docx).expect("structured DOCX export");
        assert!(docx.windows(b"E=mc^2".len()).any(|window| window == b"E=mc^2"));
    }

    #[test]
    fn json_preserves_source_identity_generation_and_polygon() {
        let mut document = ExportDocument::new("Report");
        document.set_identity("sha256:source", 7);
        document.push_page(vec![ExportBlock::text("p1-r1", "Source", Some("Bản dịch".into())).with_polygon([[0.1, 0.2], [0.4, 0.2], [0.4, 0.6], [0.1, 0.6]])]);

        let text = export_document(&document, ExportFormat::Json);
        let parsed: JsonExport = serde_json::from_str(&text).expect("the export is JSON");
        assert_eq!(parsed.source_id.as_deref(), Some("sha256:source"));
        assert_eq!(parsed.generation, Some(7));
        assert_eq!(parsed.blocks[0].polygon, Some([[0.1, 0.2], [0.4, 0.2], [0.4, 0.6], [0.1, 0.6]]));
    }

    #[test]
    fn json_parses_back_to_the_same_document() {
        let text = export_document(&sample(), ExportFormat::Json);
        let parsed: JsonExport = serde_json::from_str(&text).expect("the export is JSON");
        assert_eq!(serde_json::to_string_pretty(&parsed).expect("print the parsed export"), text, "parsing and printing again must not change a byte");
        let blocks: Vec<(&str, usize, &str, Option<&str>)> = parsed.blocks.iter().map(|block| (block.id.as_str(), block.page, block.source.as_str(), block.translation.as_deref())).collect();
        assert_eq!(blocks, vec![("p1-b1", 1, "Revenue rose", Some("Doanh thu tăng")), ("p1-b2", 1, "Costs fell", None), ("p2-b1", 2, "Outlook", Some("Triển vọng"))]);
    }

    #[test]
    fn an_assembled_document_keeps_page_order_pairs_markdown_and_marks_json() {
        let document = assembled();
        let blocks: Vec<(usize, &str, Option<&str>)> = document.blocks().map(|(page, block)| (page, block.source.as_str(), block.translation.as_deref())).collect();
        assert_eq!(blocks, vec![(1, "Revenue rose", Some("Doanh thu tăng")), (2, "Outlook", None)], "the reader's pages keep their numbers and reading order");
        let markdown = export_document(&document, ExportFormat::Markdown);
        assert!(markdown.starts_with("# Quarterly report\n"), "{markdown}");
        assert!(markdown.contains("> Revenue rose\n\nDoanh thu tăng"), "a translated block keeps both languages: {markdown}");
        assert!(markdown.contains("> Outlook"), "an untranslated block keeps its source: {markdown}");
        assert!(markdown.contains(tr3("（尚未翻译）", "(not translated yet)", "(chưa dịch)")), "{markdown}");
        assert!(markdown.find(&page_heading(1)) < markdown.find("> Revenue rose"), "{markdown}");
        assert!(markdown.find("> Revenue rose") < markdown.find(&page_heading(2)), "{markdown}");
        assert!(markdown.find(&page_heading(2)) < markdown.find("> Outlook"), "{markdown}");
        let text = export_document(&document, ExportFormat::Text);
        assert!(text.contains("Doanh thu tăng"));
        assert!(!text.contains("Outlook"), "the plain text keeps translations only: {text:?}");
        let parsed: JsonExport = serde_json::from_str(&export_document(&document, ExportFormat::Json)).expect("the export is JSON");
        assert_eq!(parsed.pages, 2);
        assert_eq!((parsed.blocks[0].page, parsed.blocks[0].untranslated), (1, false));
        assert_eq!((parsed.blocks[1].page, parsed.blocks[1].untranslated), (2, true), "the untranslated block says so instead of passing its source off as a translation");
        assert_eq!(parsed.blocks[1].source, "Outlook", "JSON keeps the source a consumer falls back to");
        assert_eq!(parsed.blocks[1].translation, None);
    }

    #[test]
    fn a_page_gap_keeps_a_later_page_number_true() {
        let document = ExportDocument::from_pages("Report", [(2, vec![ExportBlock::text("p3-r1", "Outlook", Some("Triển vọng".into()))])]);
        assert_eq!(document.pages.len(), 3, "pages nobody held stay as gaps, so page three is still page three");
        assert!(document.pages[0].blocks.is_empty() && document.pages[1].blocks.is_empty());
        let parsed: JsonExport = serde_json::from_str(&export_document(&document, ExportFormat::Json)).expect("the export is JSON");
        assert_eq!(parsed.pages, 3);
        assert_eq!(parsed.blocks[0].page, 3);
    }

    #[test]
    fn an_assembled_document_without_pages_still_writes_a_valid_file() {
        let dir = temp_dir();
        let empty = ExportDocument::from_pages("Empty report", []);
        assert!(empty.is_empty());
        for format in [ExportFormat::Markdown, ExportFormat::Text, ExportFormat::Json] {
            let content = export_document(&empty, format);
            let path = write_export(&dir, &suggested_name(&empty.title, format), &content, false).expect("an empty document is still a file");
            assert_eq!(std::fs::read_to_string(&path).expect("read the written file"), content);
            if format == ExportFormat::Json {
                let parsed: JsonExport = serde_json::from_str(&content).expect("an empty export is still JSON");
                assert_eq!((parsed.document.as_str(), parsed.pages, parsed.blocks.len()), ("Empty report", 0, 0));
            }
        }
        assert_eq!(files(&dir).len(), 3, "one file per format and no temporary: {:?}", files(&dir));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn every_format_names_itself_for_the_menu() {
        assert_eq!(ExportFormat::Markdown.label(), "Markdown");
        assert_eq!(ExportFormat::Text.label(), tr3("纯文本", "Plain text", "Văn bản thuần"));
        assert_eq!(ExportFormat::Json.label(), "JSON");
        assert_eq!(ExportFormat::Html.label(), "HTML");
        assert_eq!(ExportFormat::Docx.label(), "DOCX");
        assert_eq!(ExportFormat::TranslatedPdf.label(), tr3("翻译 PDF", "Translated PDF", "PDF đã dịch"));
    }

    #[test]
    fn a_write_leaves_the_file_and_no_temporary_behind() {
        let dir = temp_dir();
        let path = write_export(&dir, "notes.md", "# Notes\n", false).expect("write the export");
        assert_eq!(path, dir.join("notes.md"));
        assert_eq!(std::fs::read_to_string(&path).expect("read the written file"), "# Notes\n");
        assert_eq!(files(&dir), vec!["notes.md".to_string()], "the temporary file is renamed into place, not left beside it");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_write_creates_the_folders_a_chosen_path_names() {
        let dir = temp_dir();
        let nested = dir.join("exports").join("2026");
        let path = write_export(&nested, "report.json", "{}", false).expect("write into a folder that did not exist");
        assert!(path.is_file());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_no_overwrite_publish_rejects_a_destination_created_after_the_check() {
        let dir = temp_dir();
        let temporary = dir.join(".notes.txt.tmp");
        let target = dir.join("notes.txt");
        write_temp(&temporary, b"new").expect("write the temporary export");
        std::fs::write(&target, b"racing writer").expect("simulate a destination created after preflight");

        assert!(publish_temp(&temporary, &target, false).is_err(), "exclusive publication must refuse the racing destination");
        assert_eq!(std::fs::read(&target).expect("read the winner"), b"racing writer");
        assert_eq!(std::fs::read(&temporary).expect("the failed publish keeps its temporary for cleanup"), b"new");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_existing_file_is_kept_unless_the_caller_allows_the_replacement() {
        let dir = temp_dir();
        let path = write_export(&dir, "notes.txt", "first", false).expect("write the first export");
        assert!(write_export(&dir, "notes.txt", "second", false).is_err(), "a second export must not silently replace the first");
        assert_eq!(std::fs::read_to_string(&path).expect("read the first export"), "first");
        write_export(&dir, "notes.txt", "second", true).expect("the caller agreed to replace the file");
        assert_eq!(std::fs::read_to_string(&path).expect("read the replacement"), "second");
        assert_eq!(files(&dir), vec!["notes.txt".to_string()]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_path_that_is_not_a_file_name_is_refused() {
        let dir = temp_dir();
        assert!(write_export(&dir, "", "x", false).is_err(), "an empty name is not a file");
        assert!(write_export(&dir, "..", "x", false).is_err(), "a name may not walk out of the chosen folder");
        assert!(write_export(&dir, "sub/notes.md", "x", false).is_err(), "a name may not carry a folder");
        assert!(files(&dir).is_empty(), "a refused name writes nothing: {:?}", files(&dir));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_chosen_extension_decides_the_format() {
        assert_eq!(ExportFormat::from_path(Path::new("notes.pdf")), ExportFormat::Pdf);
        assert_eq!(ExportFormat::from_path(Path::new("notes.translated.pdf")), ExportFormat::TranslatedPdf);
        assert_eq!(ExportFormat::from_path(Path::new("C:/docs/NOTES.TRANSLATED.PDF")), ExportFormat::TranslatedPdf);
        assert_eq!(ExportFormat::from_path(Path::new("notes.md")), ExportFormat::Markdown);
        assert_eq!(ExportFormat::from_path(Path::new("notes.txt")), ExportFormat::Text);
        assert_eq!(ExportFormat::from_path(Path::new("notes.json")), ExportFormat::Json);
        assert_eq!(ExportFormat::from_path(Path::new("C:/docs/NOTES.JSON")), ExportFormat::Json, "Windows save panels upper-case extensions");
        assert_eq!(ExportFormat::from_path(Path::new("notes.rtf")), ExportFormat::Markdown, "an extension we do not write falls back to Markdown rather than refusing the export");
        assert_eq!(ExportFormat::from_path(Path::new("notes")), ExportFormat::Markdown);
        for format in [ExportFormat::Markdown, ExportFormat::Text, ExportFormat::Json] {
            let name = format!("notes.{}", format.extension());
            assert_eq!(ExportFormat::from_path(Path::new(&name)), format);
        }
    }

    #[test]
    fn an_empty_document_still_writes_a_valid_file() {
        let dir = temp_dir();
        let empty = ExportDocument::new("Empty report");
        assert!(empty.is_empty());
        for format in [ExportFormat::Markdown, ExportFormat::Text, ExportFormat::Json] {
            let content = export_document(&empty, format);
            let path = write_export(&dir, &suggested_name(&empty.title, format), &content, false).expect("an empty document is still a file");
            let written = std::fs::read_to_string(&path).expect("read the written file");
            assert_eq!(written, content);
            match format {
                ExportFormat::Json => {
                    let parsed: JsonExport = serde_json::from_str(&written).expect("an empty export is still JSON");
                    assert_eq!((parsed.document.as_str(), parsed.pages, parsed.blocks.len()), ("Empty report", 0, 0));
                }
                ExportFormat::Markdown => assert!(written.starts_with("# Empty report")),
                ExportFormat::Text => assert!(written.starts_with("Empty report")),
                ExportFormat::Pdf | ExportFormat::TranslatedPdf | ExportFormat::Html | ExportFormat::Docx => unreachable!("binary formats use export_document_bytes or an explicit PDF writer"),
            }
        }
        assert_eq!(files(&dir).len(), 3, "each format is its own file, and no temporary survives: {:?}", files(&dir));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_document_without_a_title_uses_the_local_name() {
        let text = export_document(&ExportDocument::default(), ExportFormat::Markdown);
        assert!(text.starts_with(&format!("# {}", tr3("文档", "Document", "Tài liệu"))), "{text}");
    }

    #[test]
    fn flat_text_becomes_one_block_per_paragraph() {
        let document = ExportDocument::from_text("Report", "First paragraph.\r\n\r\nSecond paragraph.\n\n\n");
        assert_eq!(document.block_count(), 2);
        let blocks: Vec<(&str, usize)> = document.blocks().map(|(page, block)| (block.id.as_str(), page)).collect();
        assert_eq!(blocks, vec![("p1-b1", 1), ("p1-b2", 1)]);
        assert!(export_document(&document, ExportFormat::Markdown).contains("> Second paragraph."));
        assert!(ExportDocument::from_text("Report", "  \n\n  ").is_empty(), "whitespace is not a paragraph");
    }

    #[test]
    fn a_title_becomes_one_file_name() {
        assert_eq!(file_stem("Quarterly report"), "Quarterly report");
        assert_eq!(file_stem("Q1/2026: revenue?"), "Q1_2026_ revenue_");
        assert_eq!(file_stem("  spaced   out  "), "spaced out");
        assert_eq!(file_stem("dotted..."), "dotted");
        assert_eq!(file_stem("   "), tr3("文档", "document", "tài liệu"));
        assert_eq!(file_stem(".."), tr3("文档", "document", "tài liệu"));
        assert_eq!(file_stem(&"x".repeat(500)).chars().count(), 120);
        assert!(!file_stem("two\nlines").contains('\n'));
        assert_eq!(suggested_name("Quarterly report", ExportFormat::Json), "Quarterly report.json");
    }

    #[test]
    fn a_save_panel_path_is_written_where_it_points() {
        let dir = temp_dir();
        let path = dir.join("chosen.json");
        let written = write_export_path(&path, "{}", false).expect("write the chosen path");
        assert_eq!(written, path);
        assert!(path.is_file());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn pdf_save_as_preserves_source_bytes_and_conflicts_are_refused() {
        let dir = temp_dir();
        let path = dir.join("chosen.pdf");
        let source = b"%PDF-1.7\nsource bytes\n%%EOF";
        let written = write_export_bytes_path(&path, source, false).expect("write the source PDF");
        assert_eq!(written, path);
        assert_eq!(std::fs::read(&path).unwrap(), source);
        assert!(write_export_bytes_path(&path, b"replacement", false).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), source);
        let _ = std::fs::remove_dir_all(&dir);
    }
    fn translated_pdf_input(source: &[u8]) -> TranslatedPdfInput {
        let digest: [u8; 32] = Sha256::digest(source).into();
        TranslatedPdfInput {
            title: "Quarterly report".into(),
            source_id: "source-1".into(),
            source_sha256: digest,
            source_path: None,
            pages: vec![TranslatedPdfPage {
                source_id: "source-1".into(),
                page_number: 1,
                width: 300.0,
                height: 200.0,
                blocks: vec![TranslatedPdfBlock {
                    id: "p1-b1".into(),
                    source: "Revenue rose".into(),
                    translation: Some("Doanh thu tang".into()),
                    rect: [[20.0, 20.0], [280.0, 20.0], [280.0, 100.0], [20.0, 100.0]],
                }],
            }],
        }
    }

    #[test]
    fn translated_pdf_bytes_are_deterministic_bilingual_and_have_explicit_font_warning() {
        let source = b"%PDF-1.4\nretained source";
        let input = translated_pdf_input(source);
        let first = build_translated_pdf(source, &input).unwrap();
        let second = build_translated_pdf(source, &input).unwrap();
        assert_eq!(first.bytes, second.bytes);
        assert!(first.bytes.starts_with(b"%PDF-1.4"));
        assert!(String::from_utf8_lossy(&first.bytes).contains("/BaseFont /Helvetica"));
        assert_eq!(
            first.warnings,
            vec![
                "font-not-embedded: output uses the PDF standard Helvetica font; portability is limited to Windows-1252 glyphs"
            ]
        );
        let text = String::from_utf8_lossy(&first.bytes);
        assert!(
            text.contains("Revenue rose") && text.contains("Doanh thu tang"),
            "source and supplied translation appear in the PDF content stream: {text}"
        );
        let mut two_pages = input.clone();
        let mut second = two_pages.pages[0].clone();
        second.page_number = 2;
        second.blocks[0].id = "p2-b1".into();
        second.blocks[0].source = "Second page source".into();
        second.blocks[0].translation = Some("Second page translation".into());
        two_pages.pages.push(second);
        let mapped = build_translated_pdf(source, &two_pages).unwrap();
        let mapped = String::from_utf8_lossy(&mapped.bytes);
        assert!(mapped.contains("/Count 2") && mapped.contains("/MediaBox [0 0 300.00 200.00]"));
        assert!(mapped.contains("Second page source") && mapped.contains("Second page translation"));
    }

    #[test]
    fn translated_pdf_requires_source_identity_and_exact_page_block_geometry() {
        let source = b"%PDF-1.4\nsource";
        let mut input = translated_pdf_input(source);
        input.pages[0].source_id = "other-source".into();
        assert!(
            build_translated_pdf(source, &input)
                .unwrap_err()
                .to_string()
                .contains("different source identity")
        );
        let mut input = translated_pdf_input(source);
        input.pages[0].blocks[0].rect[2][0] = f32::NAN;
        assert!(
            build_translated_pdf(source, &input)
                .unwrap_err()
                .to_string()
                .contains("non-finite geometry")
        );
        let mut input = translated_pdf_input(source);
        input.pages[0].page_number = 2;
        assert!(
            build_translated_pdf(source, &input)
                .unwrap_err()
                .to_string()
                .contains("page mapping")
        );
        let mut input = translated_pdf_input(source);
        let duplicate = input.pages[0].blocks[0].clone();
        input.pages[0].blocks.push(duplicate);
        assert!(
            build_translated_pdf(source, &input)
                .unwrap_err()
                .to_string()
                .contains("unique")
        );
    }

    #[test]
    fn untranslated_blocks_abstain_and_layout_or_font_limitations_fail_explicitly() {
        let source = b"%PDF-1.4\nsource";
        let mut input = translated_pdf_input(source);
        input.pages[0].blocks[0].translation = None;
        let output = build_translated_pdf(source, &input).unwrap();
        assert_eq!(output.missing_translation_blocks, vec!["p1-b1"]);
        assert!(String::from_utf8_lossy(&output.bytes).contains("[Translation unavailable]"));
        let mut input = translated_pdf_input(source);
        input.pages[0].blocks[0].translation = Some("中文".into());
        assert!(
            build_translated_pdf(source, &input)
                .unwrap_err()
                .to_string()
                .contains("Windows-1252")
        );
        let mut input = translated_pdf_input(source);
        input.pages[0].blocks[0].rect = [[20.0, 20.0], [280.0, 20.0], [280.0, 35.0], [20.0, 35.0]];
        assert!(
            build_translated_pdf(source, &input)
                .unwrap_err()
                .to_string()
                .contains("layout overflow")
        );
    }

    #[test]
    fn translated_pdf_does_not_mutate_the_retained_source_and_rejects_hash_mismatch() {
        let source = b"%PDF-1.4\nimmutable source bytes".to_vec();
        let before = source.clone();
        let input = translated_pdf_input(&source);
        let output = build_translated_pdf(&source, &input).unwrap();
        assert_ne!(output.bytes, source);
        assert_eq!(source, before);
        let mut wrong = input;
        wrong.source_sha256[0] ^= 1;
        assert!(
            build_translated_pdf(&source, &wrong)
                .unwrap_err()
                .to_string()
                .contains("hash does not match")
        );
        assert_eq!(source, before);
    }

    #[test]
    fn translated_pdf_writer_refuses_conflicts_source_overwrite_and_cancelled_publish() {
        use std::sync::atomic::AtomicBool;
        let dir = temp_dir();
        let source_path = dir.join("source.pdf");
        let source = b"%PDF-1.4\nsource bytes";
        std::fs::write(&source_path, source).unwrap();
        let mut input = translated_pdf_input(source);
        input.source_path = Some(source_path.clone());
        let cancelled = AtomicBool::new(false);
        assert!(write_translated_pdf_path(source, &input, &source_path, &cancelled).is_err());
        let target = dir.join("translated.pdf");
        std::fs::write(&target, b"keep existing").unwrap();
        assert!(write_translated_pdf_path(source, &input, &target, &cancelled).is_err());
        assert_eq!(std::fs::read(&target).unwrap(), b"keep existing");
        std::fs::remove_file(&target).unwrap();
        cancelled.store(true, std::sync::atomic::Ordering::Release);
        assert!(write_translated_pdf_path(source, &input, &target, &cancelled).is_err());
        assert!(!target.exists());
        cancelled.store(false, std::sync::atomic::Ordering::Release);
        let staged = dir.join(".cancelled.pdf.tmp");
        write_temp(&staged, b"staged output").unwrap();
        cancelled.store(true, std::sync::atomic::Ordering::Release);
        let publish = publish_translated_temp(&staged, &target, &cancelled);
        if publish.is_err() {
            let _ = std::fs::remove_file(&staged);
        }
        assert!(publish.is_err());
        assert!(
            !target.exists() && !staged.exists(),
            "cancellation rolls back the staged output"
        );
        assert_eq!(files(&dir), vec!["source.pdf".to_string()]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn translated_pdf_reopens_with_pdfinfo_and_text_extracts() {
        let source = b"%PDF-1.4\nsource";
        let output = build_translated_pdf(source, &translated_pdf_input(source)).unwrap();
        let dir = temp_dir();
        let path = dir.join("translated.pdf");
        std::fs::write(&path, output.bytes).unwrap();
        if std::process::Command::new("pdfinfo")
            .arg(&path)
            .output()
            .is_ok_and(|result| result.status.success())
        {
            let info = std::process::Command::new("pdfinfo")
                .arg(&path)
                .output()
                .unwrap();
            assert!(String::from_utf8_lossy(&info.stdout).contains("Pages:           1"));
            let text = std::process::Command::new("pdftotext")
                .arg(&path)
                .arg("-")
                .output()
                .unwrap();
            assert!(text.status.success());
            let text = String::from_utf8_lossy(&text.stdout);
            assert!(
                text.contains("Revenue rose") && text.contains("Doanh thu tang"),
                "extracted PDF text: {text}"
            );
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
