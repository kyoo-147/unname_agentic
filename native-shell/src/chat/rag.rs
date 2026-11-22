use super::ChatCitation;
use crate::pdf_reader::ReaderPage;

#[derive(Clone, Debug, PartialEq)]
pub struct SourceBlock {
    pub id: String,
    pub page: usize,
    pub page_number: usize,
    pub text: String,
    pub polygon: [[f32; 2]; 4],
}

#[derive(Clone, Debug, PartialEq)]
pub struct CitationNavigation {
    pub page: usize,
    pub block_id: String,
    pub polygon: [[f32; 2]; 4],
}

#[derive(Clone, Debug, PartialEq)]
pub struct RetrievalHit {
    pub source: SourceBlock,
    pub score: usize,
}

#[derive(Clone, Debug, PartialEq)]
pub enum GroundedResult {
    Abstain(&'static str),
    Evidence(Vec<RetrievalHit>),
}

/// Creates the `p{1-based-page}-r{zero-based-rank}` ids shared with the extension IR.
pub fn source_blocks(pages: &[ReaderPage]) -> Vec<SourceBlock> {
    let mut blocks = Vec::new();
    for page in pages {
        for block in &page.blocks {
            if block.source.trim().is_empty() {
                continue;
            }
            blocks.push(SourceBlock {
                id: block.id.clone(),
                page: page.page,
                page_number: page.page_number,
                text: block.source.trim().to_string(),
                polygon: block.polygon,
            });
        }
    }
    blocks.sort_by(|left, right| {
        left.page
            .cmp(&right.page)
            .then_with(|| left.id.cmp(&right.id))
    });
    blocks
}

/// Deterministic local lexical retrieval. It never embeds or contacts a provider.
pub fn retrieve(sources: &[SourceBlock], query: &str, limit: usize) -> GroundedResult {
    if sources.is_empty() {
        return GroundedResult::Abstain("No source blocks are available.");
    }
    let query_terms = terms(query);
    if query_terms.is_empty() {
        return GroundedResult::Abstain("The question has no searchable terms.");
    }
    let mut hits: Vec<RetrievalHit> = sources
        .iter()
        .filter_map(|source| {
            let text = terms(&source.text);
            let score = query_terms
                .iter()
                .filter(|term| text.contains(*term))
                .count();
            (score > 0).then(|| RetrievalHit {
                source: source.clone(),
                score,
            })
        })
        .collect();
    hits.sort_by(|left, right| {
        right
            .score
            .cmp(&left.score)
            .then_with(|| left.source.page.cmp(&right.source.page))
            .then_with(|| left.source.id.cmp(&right.source.id))
    });
    hits.truncate(limit);
    if hits.is_empty() {
        GroundedResult::Abstain("No source block contains matching evidence.")
    } else {
        GroundedResult::Evidence(hits)
    }
}

fn terms(text: &str) -> Vec<String> {
    let mut terms = Vec::new();
    for word in text.split(|ch: char| !ch.is_alphanumeric()) {
        if word.is_empty() {
            continue;
        }
        let term = word.to_lowercase();
        if !terms.contains(&term) {
            terms.push(term);
        }
    }
    terms
}

/// Keep only unique, exact citations to retrieved blocks on their actual source page.
pub fn verified_citations(citations: &[ChatCitation], hits: &[RetrievalHit]) -> Vec<ChatCitation> {
    let mut verified = Vec::new();
    for citation in citations {
        let Some(block_id) = citation.block_id.as_deref() else {
            continue;
        };
        let Some(hit) = hits.iter().find(|hit| hit.source.id == block_id) else {
            continue;
        };
        if citation
            .page
            .is_some_and(|page| usize::from(page) != hit.source.page_number)
        {
            continue;
        }
        if verified
            .iter()
            .any(|seen: &ChatCitation| seen.block_id.as_deref() == Some(block_id))
        {
            continue;
        }
        verified.push(ChatCitation {
            page: Some(hit.source.page_number as u16),
            block_id: Some(block_id.to_string()),
            raw: citation.raw.clone(),
        });
    }
    verified
}

/// Produces a page-zero-based reader payload only for an exact verified citation.
pub fn navigation(citation: &ChatCitation, sources: &[SourceBlock]) -> Option<CitationNavigation> {
    let page_number = usize::from(citation.page?);
    let id = citation.block_id.as_deref()?;
    let source = sources
        .iter()
        .find(|source| source.page_number == page_number && source.id == id)?;
    Some(CitationNavigation {
        page: source.page,
        block_id: source.id.clone(),
        polygon: source.polygon,
    })
}

pub fn evidence_prompt(question: &str, hits: &[RetrievalHit]) -> String {
    let evidence = hits
        .iter()
        .map(|hit| {
            let marker = hit
                .source
                .id
                .strip_prefix('p')
                .and_then(|id| id.split_once("-r"))
                .map(|(page, rank)| format!("[p{page}:r{rank}]"))
                .unwrap_or_else(|| "[invalid-source-id]".to_string());
            format!("{marker} {}", hit.source.text)
        })
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "Answer only from these local source blocks. Use only the exact citation markers shown beside source blocks. If the blocks do not support an answer, say that evidence is insufficient. Do not invent citations or facts.\n\nSource blocks:\n{evidence}\n\nQuestion: {question}"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pdf_reader::document::page_from_blocks;
    use mirror_pdf_desktop::model::{BlockRect, TextBlock};

    fn page(page: usize, lines: &[&str]) -> ReaderPage {
        let blocks = lines
            .iter()
            .map(|source| TextBlock {
                id: 99,
                source: (*source).into(),
                translated: None,
                rect: BlockRect {
                    x: 1.,
                    y: 2.,
                    width: 3.,
                    height: 4.,
                },
                background: None,
                font_size: 12.,
                bold: false,
            })
            .collect::<Vec<_>>();
        page_from_blocks("doc", 1, page, 2, &blocks)
    }

    #[test]
    fn source_identity_uses_unified_one_based_page_and_zero_based_rank() {
        let sources = source_blocks(&[page(0, &["first", "second"]), page(1, &["third"])]);
        assert_eq!(
            sources
                .iter()
                .map(|source| source.id.as_str())
                .collect::<Vec<_>>(),
            ["p1-r0", "p1-r1", "p2-r0"]
        );
        assert_eq!(sources[0].page, 0);
    }

    #[test]
    fn retrieval_ranks_local_blocks_deterministically() {
        let sources = source_blocks(&[
            page(0, &["Revenue was 12 dollars", "Costs increased"]),
            page(1, &["Revenue was 18 dollars"]),
        ]);
        let GroundedResult::Evidence(hits) = retrieve(&sources, "revenue dollars", 5) else {
            panic!("expected evidence");
        };
        assert_eq!(hits[0].source.id, "p1-r0");
        assert_eq!(hits[1].source.id, "p2-r0");
    }

    #[test]
    fn absent_sources_and_nonmatching_queries_abstain() {
        assert_eq!(
            retrieve(&[], "revenue", 5),
            GroundedResult::Abstain("No source blocks are available.")
        );
        let sources = source_blocks(&[page(0, &["Costs increased"])]);
        assert_eq!(
            retrieve(&sources, "unrelated term", 5),
            GroundedResult::Abstain("No source block contains matching evidence.")
        );
    }

    #[test]
    fn invalid_and_duplicate_citations_do_not_resolve() {
        let sources = source_blocks(&[page(0, &["Revenue"])]);
        let hits = match retrieve(&sources, "revenue", 2) {
            GroundedResult::Evidence(hits) => hits,
            _ => unreachable!(),
        };
        let citations = vec![
            ChatCitation {
                page: Some(1),
                block_id: Some("p1-r0".into()),
                raw: "[p1:r0]".into(),
            },
            ChatCitation {
                page: Some(1),
                block_id: Some("p1-r0".into()),
                raw: "[#p1-r0]".into(),
            },
            ChatCitation {
                page: Some(2),
                block_id: Some("p1-r0".into()),
                raw: "[p2:r0]".into(),
            },
            ChatCitation {
                page: Some(1),
                block_id: Some("p1-r9".into()),
                raw: "[p1:r9]".into(),
            },
        ];
        assert_eq!(verified_citations(&citations, &hits).len(), 1);
    }

    #[test]
    fn navigation_converts_one_based_citation_to_zero_based_page() {
        let sources = source_blocks(&[page(0, &["first"]), page(1, &["second"])]);
        let citation = ChatCitation {
            page: Some(2),
            block_id: Some("p2-r0".into()),
            raw: "[p2:r0]".into(),
        };
        assert_eq!(
            navigation(&citation, &sources),
            Some(CitationNavigation {
                page: 1,
                block_id: "p2-r0".into(),
                polygon: [[1., 2.], [4., 2.], [4., 6.], [1., 6.]]
            })
        );
        assert!(
            navigation(
                &ChatCitation {
                    page: Some(0),
                    block_id: None,
                    raw: "[p0]".into()
                },
                &sources
            )
            .is_none()
        );
    }
}
