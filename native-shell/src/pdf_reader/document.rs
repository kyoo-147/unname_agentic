//! Immutable native document pages shared by export and future OCR/RAG paths.
//!
//! The reader renders one page at a time, but a document is not one page. This
//! module keeps the document-level identity and page slots separate from the
//! viewport so callers can export or index every page without renumbering gaps.

use mirror_pdf_desktop::model::TextBlock;

pub type Polygon = [[f32; 2]; 4];

#[derive(Clone, Debug, PartialEq)]
pub struct DocumentBlock {
    pub id: String,
    pub source: String,
    pub translation: Option<String>,
    pub polygon: Polygon,
}

#[derive(Clone, Debug, PartialEq)]
pub struct DocumentPage {
    pub source_id: String,
    pub generation: u64,
    pub page: usize,
    pub page_number: usize,
    pub page_count: usize,
    pub blocks: Vec<DocumentBlock>,
}

/// A document snapshot with one immutable slot for every page.
///
/// Empty slots are real page gaps, not omitted pages. A page is marked loaded
/// only after a frame with the matching source id and generation is accepted.
#[derive(Clone, Debug, PartialEq)]
pub struct DocumentPages {
    pub source_id: String,
    pub generation: u64,
    pub page_count: usize,
    pages: Vec<DocumentPage>,
    loaded: Vec<bool>,
}

impl DocumentPages {
    pub fn new(source_id: impl Into<String>, generation: u64, page_count: usize) -> Self {
        let source_id = source_id.into();
        let pages = (0..page_count)
            .map(|page| empty_page(source_id.clone(), generation, page, page_count))
            .collect();
        Self {
            source_id,
            generation,
            page_count,
            pages,
            loaded: vec![false; page_count],
        }
    }

    pub fn insert(&mut self, page: DocumentPage) -> bool {
        if page.source_id != self.source_id
            || page.generation != self.generation
            || page.page >= self.page_count
            || page.page_number != page.page + 1
            || page.page_count != self.page_count
        {
            return false;
        }
        let page_index = page.page;
        self.loaded[page_index] = true;
        self.pages[page_index] = page;
        true
    }

    pub fn is_loaded(&self, page: usize) -> bool {
        self.loaded.get(page).copied().unwrap_or(false)
    }

    pub fn is_complete(&self) -> bool {
        self.loaded.iter().all(|loaded| *loaded)
    }

    pub fn missing_pages(&self) -> impl Iterator<Item = usize> + '_ {
        self.loaded
            .iter()
            .enumerate()
            .filter_map(|(page, loaded)| (!*loaded).then_some(page))
    }

    /// Returns copies so a consumer cannot mutate the reader's document state.
    pub fn snapshot(&self) -> Vec<DocumentPage> {
        self.pages.clone()
    }
}

pub fn page_from_blocks(
    source_id: impl Into<String>,
    generation: u64,
    page: usize,
    page_count: usize,
    blocks: &[TextBlock],
) -> DocumentPage {
    let source_id = source_id.into();
    let blocks = blocks
        .iter()
        .enumerate()
        .map(|(index, block)| DocumentBlock {
            id: format!("p{}-r{}", page + 1, index + 1),
            source: block.source.clone(),
            translation: block.translated.clone(),
            polygon: polygon(
                block.rect.x,
                block.rect.y,
                block.rect.width,
                block.rect.height,
            ),
        })
        .collect();
    DocumentPage {
        source_id,
        generation,
        page,
        page_number: page + 1,
        page_count,
        blocks,
    }
}

fn empty_page(source_id: String, generation: u64, page: usize, page_count: usize) -> DocumentPage {
    DocumentPage {
        source_id,
        generation,
        page,
        page_number: page + 1,
        page_count,
        blocks: Vec::new(),
    }
}

fn polygon(x: f32, y: f32, width: f32, height: f32) -> Polygon {
    [
        [x, y],
        [x + width, y],
        [x + width, y + height],
        [x, y + height],
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use mirror_pdf_desktop::model::{BlockRect, TextBlock};

    fn block(source: &str) -> TextBlock {
        TextBlock {
            id: 7,
            source: source.into(),
            translated: Some("translation".into()),
            rect: BlockRect {
                x: 0.1,
                y: 0.2,
                width: 0.3,
                height: 0.4,
            },
            background: None,
            font_size: 12.,
            bold: false,
        }
    }

    #[test]
    fn full_document_snapshot_keeps_page_numbers_and_block_polygons() {
        let mut document = DocumentPages::new("sha256:doc", 4, 3);
        assert!(document.insert(page_from_blocks("sha256:doc", 4, 0, 3, &[block("first")])));
        assert!(document.insert(page_from_blocks("sha256:doc", 4, 2, 3, &[block("last")])));

        let pages = document.snapshot();
        assert_eq!(pages.len(), 3);
        assert_eq!(pages[0].page_number, 1);
        assert_eq!(pages[2].page_number, 3);
        assert_eq!(pages[0].blocks[0].source, "first");
        assert_eq!(
            pages[0].blocks[0].polygon,
            [[0.1, 0.2], [0.4, 0.2], [0.4, 0.6], [0.1, 0.6]]
        );
        assert_eq!(pages[2].blocks[0].id, "p3-r1");
        assert_eq!(pages[0].source_id, "sha256:doc");
        assert!(!document.is_complete());
    }

    #[test]
    fn page_gaps_are_explicit_empty_slots() {
        let mut document = DocumentPages::new("doc", 1, 4);
        assert!(document.insert(page_from_blocks("doc", 1, 3, 4, &[block("page four")])));

        let pages = document.snapshot();
        assert_eq!(
            pages
                .iter()
                .map(|page| page.page_number)
                .collect::<Vec<_>>(),
            vec![1, 2, 3, 4]
        );
        assert!(pages[0].blocks.is_empty());
        assert!(pages[1].blocks.is_empty());
        assert!(pages[2].blocks.is_empty());
        assert_eq!(pages[3].blocks[0].source, "page four");
        assert_eq!(document.missing_pages().collect::<Vec<_>>(), vec![0, 1, 2]);
    }

    #[test]
    fn stale_generation_or_source_cannot_enter_the_snapshot() {
        let mut document = DocumentPages::new("new-source", 8, 2);
        assert!(!document.insert(page_from_blocks(
            "new-source",
            7,
            0,
            2,
            &[block("old generation")]
        )));
        assert!(!document.insert(page_from_blocks(
            "old-source",
            8,
            0,
            2,
            &[block("old source")]
        )));
        assert!(document.insert(page_from_blocks("new-source", 8, 0, 2, &[block("current")])));
        assert_eq!(document.snapshot()[0].blocks[0].source, "current");
    }
}
