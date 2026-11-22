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
use std::path::{Path, PathBuf};

/// The plain-text page break: `\f`, the marker text tools have used for pages
/// since long before this program existed.
pub const PAGE_BREAK: char = '\u{c}';

/// The file forms an export can take.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExportFormat {
    /// The retained source PDF, copied byte-for-byte by the Save As action.
    Pdf,
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
        path.extension().and_then(|extension| extension.to_str()).map_or(Self::Markdown, Self::from_extension)
    }

    /// The menu label: the format's own name, except plain text, which each
    /// interface language names for itself.
    pub fn label(self) -> &'static str {
        match self {
            Self::Pdf => tr3("原始 PDF", "Original PDF", "PDF gốc"),
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
            "txt" | "text" => Self::Text,
            "html" | "htm" => Self::Html,
            "docx" => Self::Docx,
            "json" => Self::Json,
            _ => Self::Markdown,
        }
    }

    /// Whether this format can be generated from the native snapshot without
    /// pretending to be a translated-PDF writer.
    pub fn can_generate(self) -> bool { !matches!(self, Self::Pdf) }

    /// The preservation promise shown by provider/export UX and reports.
    pub fn preservation(self) -> &'static str {
        match self {
            Self::Pdf => "source bytes, fonts, images, vectors, bookmarks and hyperlinks preserved exactly",
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
        ExportFormat::Pdf | ExportFormat::Docx => String::new(),
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

/// Return bytes for every genuinely supported export. PDF is intentionally
/// rejected here: the only native PDF path is an exact copy of retained source
/// bytes, never a translated-PDF writer.
pub fn export_document_bytes(document: &ExportDocument, format: ExportFormat) -> Result<Vec<u8>> {
    match format {
        ExportFormat::Pdf => anyhow::bail!("Translated PDF writing is not implemented; use Save As on the retained source PDF."),
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
    std::fs::write(&temp.path, content).with_context(|| tr3_fill("无法写入 {}", "Cannot write {}", "Không ghi được {}", temp.path.display()))?;
    // Windows refuses to rename onto an existing file, and an overwriting caller
    // is the one a save panel has already confirmed the replacement with.
    if overwrite && target.exists() {
        std::fs::remove_file(&target).with_context(|| tr3_fill("无法替换 {}", "Cannot replace {}", "Không thay được {}", target.display()))?;
    }
    std::fs::rename(&temp.path, &target).with_context(|| tr3_fill("无法写入 {}", "Cannot write {}", "Không ghi được {}", target.display()))?;
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
        std::fs::write(&temporary, bytes).with_context(|| tr3_fill("无法写入 {}", "Cannot write {}", "Không ghi được {}", temporary.display()))?;
        if overwrite && target.exists() { std::fs::remove_file(&target).with_context(|| tr3_fill("无法替换 {}", "Cannot replace {}", "Không thay được {}", target.display()))?; }
        std::fs::rename(&temporary, &target).with_context(|| tr3_fill("无法写入 {}", "Cannot write {}", "Không ghi được {}", target.display()))?;
        Ok(target)
    })();
    if result.is_err() { let _ = std::fs::remove_file(&temporary); }
    result
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
                ExportFormat::Pdf | ExportFormat::Html | ExportFormat::Docx => unreachable!("binary formats use export_document_bytes or retained PDF Save As"),
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
}
