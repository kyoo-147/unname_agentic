//! Local-first research workspace contracts for the native shell.
//!
//! This module is deliberately UI- and network-free. The parent shell can own a
//! `ResearchStore` beside `Store`, render these records, and call `propose_*` /
//! `confirm_*` explicitly. No metadata lookup or remote fetch is performed.
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeSet,
    fs,
    io::Write,
    path::{Path, PathBuf},
};

pub const SCHEMA_VERSION: u32 = 1;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceStatus {
    Supported,
    Partial,
    Unknown,
    Unverified,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct ExactLocator {
    pub document_id: String,
    pub source_sha256: String,
    pub revision_id: String,
    /// One-based PDF page number.
    pub page: u32,
    pub block_id: Option<String>,
    /// Exact source excerpt, never generated/rephrased content.
    pub quote: Option<String>,
    /// Page-point coordinates in source order; each point is [x, y].
    #[serde(default)]
    pub polygon: Vec<[f64; 2]>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct KnowledgeCard {
    pub card_id: String,
    pub paper_id: String,
    pub title: String,
    pub body: String,
    pub status: EvidenceStatus,
    pub locator: Option<ExactLocator>,
    pub provenance: String,
    pub created_at: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct Collection {
    pub collection_id: String,
    pub name: String,
    #[serde(default)]
    pub paper_ids: Vec<String>,
    #[serde(default)]
    pub tags: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Paper {
    pub paper_id: String,
    pub title: String,
    #[serde(default)]
    pub authors: Vec<String>,
    /// `None` explicitly means UNKNOWN; no external lookup is attempted.
    pub doi: Option<String>,
    pub year: Option<u16>,
    #[serde(default)]
    pub metadata_state: MetadataState,
    /// Unknown RIS tags retained through local import/export round-trips.
    #[serde(default)]
    pub ris_extra: Vec<(String, String)>,
}

impl Default for Paper {
    fn default() -> Self {
        Self {
            paper_id: String::new(),
            title: String::new(),
            authors: vec![],
            doi: None,
            year: None,
            metadata_state: MetadataState::Unknown,
            ris_extra: vec![],
        }
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MetadataState {
    #[default]
    Unknown,
    Unverified,
    Verified,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct MetadataProposal {
    pub proposal_id: String,
    pub paper_id: String,
    pub field: String,
    pub proposed_value: String,
    pub source: String,
    pub state: ProposalState,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProposalState {
    Pending,
    Accepted,
    Rejected,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct DuplicateProposal {
    pub paper_ids: Vec<String>,
    pub reason: String,
    pub confirmed: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct Workspace {
    pub papers: Vec<Paper>,
    pub cards: Vec<KnowledgeCard>,
    pub collections: Vec<Collection>,
    pub proposals: Vec<MetadataProposal>,
    pub duplicate_proposals: Vec<DuplicateProposal>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
struct VersionedWorkspace {
    version: u32,
    workspace: Workspace,
}

/// Durable, atomic JSON persistence under `<library>/research/workspace.json`.
pub struct ResearchStore {
    root: PathBuf,
    workspace: Workspace,
}

impl ResearchStore {
    pub fn open_at(library_root: impl Into<PathBuf>) -> Result<Self> {
        let root = library_root.into().join("research");
        fs::create_dir_all(&root).with_context(|| format!("create {}", root.display()))?;
        let path = root.join("workspace.json");
        let workspace = if path.exists() {
            let bytes = fs::read(&path).context("read research workspace")?;
            let versioned: VersionedWorkspace =
                serde_json::from_slice(&bytes).context("parse research workspace")?;
            anyhow::ensure!(
                versioned.version == SCHEMA_VERSION,
                "unsupported research workspace version {}",
                versioned.version
            );
            versioned.workspace
        } else {
            Workspace::default()
        };
        Ok(Self { root, workspace })
    }
    pub fn workspace(&self) -> &Workspace {
        &self.workspace
    }
    pub fn save(&self) -> Result<()> {
        let bytes = serde_json::to_vec_pretty(&VersionedWorkspace {
            version: SCHEMA_VERSION,
            workspace: self.workspace.clone(),
        })?;
        atomic_write(&self.root.join("workspace.json"), &bytes)
    }
    pub fn add_paper(&mut self, paper: Paper) -> Result<()> {
        anyhow::ensure!(
            !paper.paper_id.trim().is_empty() && !paper.title.trim().is_empty(),
            "paper id and title are required"
        );
        anyhow::ensure!(
            !self
                .workspace
                .papers
                .iter()
                .any(|p| p.paper_id == paper.paper_id),
            "paper already exists"
        );
        self.workspace.papers.push(paper);
        self.save()
    }
    pub fn add_card(&mut self, card: KnowledgeCard) -> Result<()> {
        anyhow::ensure!(!card.card_id.trim().is_empty(), "card id is required");
        anyhow::ensure!(
            self.workspace
                .papers
                .iter()
                .any(|p| p.paper_id == card.paper_id),
            "unknown paper"
        );
        if let Some(locator) = &card.locator {
            validate_locator(locator)?;
        }
        anyhow::ensure!(
            card.status != EvidenceStatus::Supported || card.locator.is_some(),
            "supported card requires an exact source locator"
        );
        anyhow::ensure!(
            !self
                .workspace
                .cards
                .iter()
                .any(|c| c.card_id == card.card_id),
            "card already exists"
        );
        self.workspace.cards.push(card);
        self.save()
    }
    pub fn upsert_collection(&mut self, mut collection: Collection) -> Result<()> {
        anyhow::ensure!(
            !collection.collection_id.trim().is_empty() && !collection.name.trim().is_empty(),
            "collection id and name are required"
        );
        collection
            .paper_ids
            .retain(|id| self.workspace.papers.iter().any(|p| &p.paper_id == id));
        collection.paper_ids.sort();
        collection.paper_ids.dedup();
        if let Some(old) = self
            .workspace
            .collections
            .iter_mut()
            .find(|c| c.collection_id == collection.collection_id)
        {
            *old = collection;
        } else {
            self.workspace.collections.push(collection);
        }
        self.save()
    }
    /// Store metadata as a pending review proposal. It never changes the paper.
    pub fn propose_metadata(&mut self, proposal: MetadataProposal) -> Result<()> {
        anyhow::ensure!(
            self.workspace
                .papers
                .iter()
                .any(|p| p.paper_id == proposal.paper_id),
            "unknown paper"
        );
        anyhow::ensure!(
            proposal.state == ProposalState::Pending,
            "new proposals must be pending"
        );
        anyhow::ensure!(
            !self
                .workspace
                .proposals
                .iter()
                .any(|p| p.proposal_id == proposal.proposal_id),
            "proposal already exists"
        );
        self.workspace.proposals.push(proposal);
        self.save()
    }
    pub fn accept_metadata(&mut self, proposal_id: &str) -> Result<()> {
        let idx = self
            .workspace
            .proposals
            .iter()
            .position(|p| p.proposal_id == proposal_id)
            .context("proposal not found")?;
        let proposal = self.workspace.proposals[idx].clone();
        anyhow::ensure!(
            proposal.state == ProposalState::Pending,
            "proposal is not pending"
        );
        let paper = self
            .workspace
            .papers
            .iter_mut()
            .find(|p| p.paper_id == proposal.paper_id)
            .context("paper not found")?;
        match proposal.field.as_str() {
            "title" => paper.title = proposal.proposed_value.clone(),
            "doi" => paper.doi = Some(proposal.proposed_value.clone()),
            "year" => paper.year = proposal.proposed_value.parse().ok(),
            _ => anyhow::bail!("unsupported metadata field: {}", proposal.field),
        }
        paper.metadata_state = MetadataState::Unverified;
        self.workspace.proposals[idx].state = ProposalState::Accepted;
        self.save()
    }
    /// Recompute duplicate suggestions; no merge occurs until explicitly confirmed.
    pub fn propose_duplicates(&mut self) -> Vec<DuplicateProposal> {
        let mut out = Vec::new();
        for i in 0..self.workspace.papers.len() {
            for j in (i + 1)..self.workspace.papers.len() {
                let a = &self.workspace.papers[i];
                let b = &self.workspace.papers[j];
                let doi_match = a
                    .doi
                    .as_ref()
                    .zip(b.doi.as_ref())
                    .is_some_and(|(x, y)| norm_doi(x) == norm_doi(y));
                let title_match = fold(&a.title) == fold(&b.title) && !a.title.trim().is_empty();
                if doi_match || title_match {
                    out.push(DuplicateProposal {
                        paper_ids: vec![a.paper_id.clone(), b.paper_id.clone()],
                        reason: if doi_match { "doi" } else { "title" }.into(),
                        confirmed: false,
                    });
                }
            }
        }
        self.workspace.duplicate_proposals = out.clone();
        out
    }
    pub fn confirm_duplicate(&mut self, ids: &[String], keep_id: &str) -> Result<()> {
        let proposal = self
            .workspace
            .duplicate_proposals
            .iter_mut()
            .find(|p| !p.confirmed && p.paper_ids == ids)
            .context("duplicate proposal not found")?;
        anyhow::ensure!(
            proposal.paper_ids.iter().any(|id| id == keep_id),
            "kept paper must be in proposal"
        );
        let removed: BTreeSet<_> = proposal
            .paper_ids
            .iter()
            .filter(|id| id.as_str() != keep_id)
            .cloned()
            .collect();
        let kept = self
            .workspace
            .papers
            .iter()
            .find(|p| p.paper_id == keep_id)
            .cloned()
            .context("kept paper not found")?;
        for card in &mut self.workspace.cards {
            if removed.contains(&card.paper_id) {
                card.paper_id = keep_id.to_string();
            }
        }
        for collection in &mut self.workspace.collections {
            for id in &mut collection.paper_ids {
                if removed.contains(id) {
                    *id = keep_id.to_string();
                }
            }
            collection.paper_ids.sort();
            collection.paper_ids.dedup();
        }
        self.workspace
            .papers
            .retain(|p| !removed.contains(&p.paper_id));
        let _ = kept;
        proposal.confirmed = true;
        self.save()
    }
    /// Guard a selection/highlight when layout reflow changes. Quote equality is
    /// insufficient to remap geometry; retain the old locator as UNKNOWN.
    pub fn reflow_locator(
        &self,
        locator: &ExactLocator,
        next_revision: &str,
        quote_still_exact: bool,
    ) -> ReflowDecision {
        if locator.revision_id == next_revision {
            return ReflowDecision::Keep(locator.clone());
        }
        if quote_still_exact && locator.block_id.is_some() {
            return ReflowDecision::NeedsReview(locator.clone());
        }
        ReflowDecision::Orphan(locator.clone())
    }
    pub fn export_ris(&self) -> String {
        export_ris(&self.workspace.papers)
    }
    pub fn import_ris(&mut self, input: &str) -> Result<RisImport> {
        let parsed = parse_ris(input);
        for (idx, record) in parsed.records.iter().enumerate() {
            let id = format!("ris-{}", stable_id(&record.fields, idx));
            if self.workspace.papers.iter().any(|p| p.paper_id == id) {
                continue;
            }
            let first = |tag: &str| {
                record
                    .fields
                    .iter()
                    .find(|(t, _)| t == tag)
                    .map(|(_, v)| v.clone())
            };
            let authors = record
                .fields
                .iter()
                .filter(|(tag, _)| tag == "AU" || tag == "A1")
                .map(|(_, v)| v.clone())
                .collect();
            let known = ["AU", "A1", "TI", "T1", "DO", "PY"];
            let ris_extra = record
                .fields
                .iter()
                .filter(|(tag, _)| !known.contains(&tag.as_str()))
                .cloned()
                .collect();
            self.workspace.papers.push(Paper {
                paper_id: id,
                title: first("TI")
                    .or_else(|| first("T1"))
                    .unwrap_or_else(|| "UNKNOWN".into()),
                authors,
                doi: first("DO"),
                year: first("PY").and_then(|s| s.get(..4).and_then(|y| y.parse().ok())),
                metadata_state: MetadataState::Unverified,
                ris_extra,
            });
        }
        self.save()?;
        Ok(parsed)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum ReflowDecision {
    Keep(ExactLocator),
    NeedsReview(ExactLocator),
    Orphan(ExactLocator),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RisRecord {
    pub record_type: String,
    pub fields: Vec<(String, String)>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RisError {
    pub line: usize,
    pub message: String,
}
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RisImport {
    pub records: Vec<RisRecord>,
    pub errors: Vec<RisError>,
}

/// Deterministic, offline RIS parsing. Original tag order and unknown fields stay intact.
pub fn parse_ris(input: &str) -> RisImport {
    let mut out = RisImport::default();
    let mut current: Option<RisRecord> = None;
    for (n, line) in input.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let Some((left, value)) = line.split_once("-") else {
            out.errors.push(RisError {
                line: n + 1,
                message: "expected TAG  - value".into(),
            });
            continue;
        };
        let tag = left.trim();
        if tag.len() != 2 || !tag.bytes().all(|b| b.is_ascii_alphanumeric()) {
            out.errors.push(RisError {
                line: n + 1,
                message: "RIS tag must have two ASCII characters".into(),
            });
            continue;
        }
        let value = value.trim_start().to_string();
        if tag.eq_ignore_ascii_case("TY") {
            if let Some(prev) = current.take() {
                out.errors.push(RisError {
                    line: n + 1,
                    message: "new record before ER; previous retained".into(),
                });
                out.records.push(prev);
            }
            current = Some(RisRecord {
                record_type: value,
                fields: vec![],
            });
            continue;
        }
        if current.is_none() {
            out.errors.push(RisError {
                line: n + 1,
                message: "tag before TY".into(),
            });
            continue;
        }
        if tag.eq_ignore_ascii_case("ER") {
            out.records.push(current.take().unwrap());
            continue;
        }
        current
            .as_mut()
            .unwrap()
            .fields
            .push((tag.to_ascii_uppercase(), value));
    }
    if let Some(record) = current {
        out.errors.push(RisError {
            line: input.lines().count(),
            message: "record missing ER; retained".into(),
        });
        out.records.push(record);
    }
    out
}

pub fn export_ris(papers: &[Paper]) -> String {
    let mut papers = papers.to_vec();
    papers.sort_by(|a, b| a.paper_id.cmp(&b.paper_id));
    let mut output = String::new();
    for paper in papers {
        output.push_str("TY  - JOUR\n");
        for author in paper.authors {
            output.push_str(&format!("AU  - {}\n", ris_safe(&author)));
        }
        output.push_str(&format!(
            "TI  - {}\n",
            ris_safe(if paper.title.is_empty() {
                "UNKNOWN"
            } else {
                &paper.title
            })
        ));
        if let Some(doi) = paper.doi {
            output.push_str(&format!("DO  - {}\n", ris_safe(&doi)));
        }
        if let Some(year) = paper.year {
            output.push_str(&format!("PY  - {year}\n"));
        }
        for (tag, value) in paper.ris_extra {
            if tag.len() == 2 && !["TY", "ER"].contains(&tag.as_str()) {
                output.push_str(&format!("{}  - {}\n", tag, ris_safe(&value)));
            }
        }
        output.push_str("ER  -\n\n");
    }
    output
}

fn validate_locator(l: &ExactLocator) -> Result<()> {
    anyhow::ensure!(
        !l.document_id.is_empty()
            && !l.source_sha256.is_empty()
            && !l.revision_id.is_empty()
            && l.page > 0,
        "locator requires source identity, revision, and one-based page"
    );
    anyhow::ensure!(
        l.polygon.iter().flatten().all(|v| v.is_finite()),
        "locator geometry must be finite"
    );
    Ok(())
}
fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let tmp = path.with_extension("tmp");
    let mut f = fs::File::create(&tmp)?;
    f.write_all(bytes)?;
    f.sync_all()?;
    drop(f);
    fs::rename(tmp, path)?;
    Ok(())
}
fn norm_doi(s: &str) -> String {
    s.trim()
        .to_ascii_lowercase()
        .replace("https://doi.org/", "")
        .replace("http://doi.org/", "")
        .replace("doi:", "")
}
fn fold(s: &str) -> String {
    s.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}
fn ris_safe(s: &str) -> String {
    s.replace(['\r', '\n'], " ")
}
fn stable_id(fields: &[(String, String)], idx: usize) -> String {
    let title = fields
        .iter()
        .find(|(t, _)| t == "TI" || t == "T1")
        .map(|(_, v)| v.as_str())
        .unwrap_or("");
    format!("{}-{idx}", fold(title).replace(' ', "-"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        sync::atomic::{AtomicUsize, Ordering},
        time::{SystemTime, UNIX_EPOCH},
    };
    static N: AtomicUsize = AtomicUsize::new(0);
    fn root() -> PathBuf {
        let p = std::env::temp_dir().join(format!(
            "research-native-{}-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&p).unwrap();
        p
    }
    fn paper(id: &str) -> Paper {
        Paper {
            paper_id: id.into(),
            title: "A Paper".into(),
            authors: vec!["A Author".into()],
            doi: None,
            year: Some(2024),
            metadata_state: MetadataState::Unknown,
            ris_extra: vec![],
        }
    }
    fn loc(rev: &str) -> ExactLocator {
        ExactLocator {
            document_id: "doc".into(),
            source_sha256: "abc123".into(),
            revision_id: rev.into(),
            page: 3,
            block_id: Some("b7".into()),
            quote: Some("Exact quoted source".into()),
            polygon: vec![[1., 2.], [3., 4.]],
        }
    }
    #[test]
    fn persistence_keeps_local_records_and_exact_provenance() {
        let root = root();
        let mut s = ResearchStore::open_at(&root).unwrap();
        s.add_paper(paper("p1")).unwrap();
        s.upsert_collection(Collection {
            collection_id: "reading".into(),
            name: "Reading list".into(),
            paper_ids: vec!["p1".into(), "missing".into()],
            tags: vec!["methods".into()],
        })
        .unwrap();
        s.add_card(KnowledgeCard {
            card_id: "c1".into(),
            paper_id: "p1".into(),
            title: "Note".into(),
            body: "Observation".into(),
            status: EvidenceStatus::Supported,
            locator: Some(loc("r1")),
            provenance: "user-selected PDF text".into(),
            created_at: "2026-11-22T00:00:00Z".into(),
        })
        .unwrap();
        drop(s);
        let s = ResearchStore::open_at(&root).unwrap();
        assert_eq!(s.workspace().cards[0].locator, Some(loc("r1")));
        assert_eq!(s.workspace().collections[0].paper_ids, vec!["p1"]);
        assert_eq!(
            s.workspace().papers[0].metadata_state,
            MetadataState::Unknown
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn duplicate_is_only_a_proposal_until_confirmation_and_merge_retains_card() {
        let root = root();
        let mut s = ResearchStore::open_at(&root).unwrap();
        s.add_paper(paper("a")).unwrap();
        let mut p = paper("b");
        p.title = " A   Paper ".into();
        s.add_paper(p).unwrap();
        s.add_card(KnowledgeCard {
            card_id: "c".into(),
            paper_id: "b".into(),
            title: "x".into(),
            body: "y".into(),
            status: EvidenceStatus::Supported,
            locator: Some(loc("r")),
            provenance: "manual".into(),
            created_at: "now".into(),
        })
        .unwrap();
        let proposals = s.propose_duplicates();
        assert_eq!(proposals.len(), 1);
        assert_eq!(s.workspace().papers.len(), 2);
        s.confirm_duplicate(&proposals[0].paper_ids, "a").unwrap();
        assert_eq!(s.workspace().papers.len(), 1);
        assert_eq!(s.workspace().cards[0].paper_id, "a");
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn metadata_stays_pending_and_accepted_value_remains_unverified() {
        let root = root();
        let mut s = ResearchStore::open_at(&root).unwrap();
        s.add_paper(paper("p")).unwrap();
        s.propose_metadata(MetadataProposal {
            proposal_id: "m".into(),
            paper_id: "p".into(),
            field: "doi".into(),
            proposed_value: "10.1234/example".into(),
            source: "user-provided RIS".into(),
            state: ProposalState::Pending,
        })
        .unwrap();
        assert_eq!(s.workspace().papers[0].doi, None);
        s.accept_metadata("m").unwrap();
        assert_eq!(
            s.workspace().papers[0].doi.as_deref(),
            Some("10.1234/example")
        );
        assert_eq!(
            s.workspace().papers[0].metadata_state,
            MetadataState::Unverified
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn ris_round_trip_preserves_authors_doi_title_and_unknown_fields() {
        let input = "TY  - JOUR\r\nAU  - A Author\r\nTI  - A Paper\r\nDO  - 10.1234/x\r\nZZ  - keep this\r\nER  -\r\n";
        let parsed = parse_ris(input);
        assert!(parsed.errors.is_empty());
        let unknown = parsed.records[0]
            .fields
            .iter()
            .filter(|(tag, _)| tag == "ZZ")
            .cloned()
            .collect();
        let canonical = export_ris(&[Paper {
            paper_id: "p".into(),
            title: "A Paper".into(),
            authors: vec!["A Author".into()],
            doi: Some("10.1234/x".into()),
            year: Some(2024),
            metadata_state: MetadataState::Unverified,
            ris_extra: unknown,
        }]);
        let again = parse_ris(&canonical);
        assert_eq!(again.records.len(), 1);
        assert_eq!(
            again.records[0]
                .fields
                .iter()
                .find(|(t, _)| t == "AU")
                .unwrap()
                .1,
            "A Author"
        );
        assert_eq!(
            again.records[0].fields.last().unwrap(),
            &("ZZ".into(), "keep this".into())
        );
    }
    #[test]
    fn reflow_never_silently_moves_geometry_and_offline_import_does_not_fetch() {
        let root = root();
        let mut s = ResearchStore::open_at(&root).unwrap();
        assert_eq!(
            s.reflow_locator(&loc("r1"), "r2", true),
            ReflowDecision::NeedsReview(loc("r1"))
        );
        assert_eq!(
            s.reflow_locator(&loc("r1"), "r2", false),
            ReflowDecision::Orphan(loc("r1"))
        );
        let parsed = s.import_ris("TY  - JOUR\nTI  - Local\nER  -\n").unwrap();
        assert_eq!(parsed.records.len(), 1);
        assert_eq!(
            s.workspace().papers[0].metadata_state,
            MetadataState::Unverified
        );
        assert!(s.workspace().papers[0].doi.is_none());
        fs::remove_dir_all(root).unwrap();
    }
}
