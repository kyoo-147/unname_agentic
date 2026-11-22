import {
  buildGraph,
  missingReferences,
  type CitationPaper,
} from '../core/citation-graph';
import { parseCitations } from '../core/citations';
import { buildResearchMatrix, matrixToMarkdown, type ResearchAspect, type ResearchMatrixPaper } from '../core/research/evidence';
import { exportBibliography, importBibliography, researchPaperToEntry } from '../core/research/exchange';
import { ResearchLibrary, type DuplicateCandidate } from '../core/research/library';
import { ResearchNoteStore } from '../core/research/notes';
import { resolveResearchCitationSupport } from '../core/research/citation-support';
import { buildStudyPack, toStudyPackJson } from '../core/research/study';
import {
  ResearchWorkspacePersistence,
  type ResearchWorkspaceSnapshot,
} from '../core/research/workspace';
import {
  supportedEvidence,
  unknownEvidence,
  type EvidenceBlock,
  type ResearchPaper,
} from '../core/research/types';
import { comparePapers, summarise, type PaperAspect } from '../core/paper-compare';

export type ResearchWorkspaceTab = 'library' | 'compare' | 'notes' | 'citations';

export interface ResearchWorkspaceOptions {
  persistence?: ResearchWorkspacePersistence;
  now?: () => string;
}

const ASPECTS: readonly ResearchAspect[] = [
  { id: 'methodology', label: 'Methodology', keywords: ['method', 'methodology', 'approach', 'protocol'], kind: 'methodology' },
  { id: 'dataset', label: 'Dataset / data', keywords: ['dataset', 'data', 'corpus', 'sample'], kind: 'dataset' },
  { id: 'metrics', label: 'Metrics', keywords: ['metric', 'accuracy', 'precision', 'recall', 'f1', 'performance'], kind: 'metric' },
  { id: 'limitations', label: 'Limitations', keywords: ['limitation', 'limitations', 'shortcoming', 'constraint'], kind: 'limitation' },
];

const PAPER_ASPECTS: readonly PaperAspect[] = ASPECTS.map(aspect => ({
  id: aspect.id,
  label: aspect.label,
  keywords: [...aspect.keywords],
  kind: aspect.kind === 'limitation' || aspect.kind === undefined ? 'other' : aspect.kind,
}));

export function mountResearchWorkspace(container: HTMLElement, options: ResearchWorkspaceOptions = {}): { destroy(): void } {
  const persistence = options.persistence ?? new ResearchWorkspacePersistence();
  const now = options.now ?? (() => new Date().toISOString());
  let snapshot = persistence.load();
  let tab: ResearchWorkspaceTab = 'library';
  let selectedPaperId = snapshot.activePaperId ?? snapshot.papers[0]?.paperId;
  let message = 'Local workspace ready. No network or model provider is used here.';
  let messageKind: 'info' | 'error' = 'info';

  container.innerHTML = '<div class="research-workspace" data-testid="research-workspace"></div>';
  const root = container.querySelector<HTMLElement>('[data-testid="research-workspace"]')!;

  const persist = (): void => {
    snapshot = { ...snapshot, activePaperId: selectedPaperId };
    const saved = persistence.save(snapshot);
    message = saved ? 'Saved locally.' : 'Local persistence is unavailable. Changes remain in this session only.';
    messageKind = saved ? 'info' : 'error';
  };

  const setMessage = (text: string, kind: 'info' | 'error' = 'info'): void => {
    message = text;
    messageKind = kind;
  };

  const render = (): void => {
    root.innerHTML = `
      <header class="research-hero">
        <div>
          <p class="research-kicker">FIELD NOTEBOOK / LOCAL EVIDENCE</p>
          <h1>Research desk</h1>
          <p class="research-lead">Inspect papers, compare only what the source says, and keep every gap visible.</p>
        </div>
        <div class="research-truth-badge"><span></span><strong>OFFLINE</strong><small>No enrichment requested</small></div>
      </header>
      <nav class="research-tabs" aria-label="Research workspace sections" role="tablist">
        ${tabButton('library', 'Library', 'Organise papers and exact evidence.')}
        ${tabButton('compare', 'Compare', 'Matrix cells carry page and block anchors.')}
        ${tabButton('notes', 'Notes', 'Notes require an evidence reference.')}
        ${tabButton('citations', 'Citations', 'Parse markers and inspect the local graph.')}
      </nav>
      <div class="research-status research-status--${messageKind}" role="status" aria-live="polite">${escapeHtml(message)}</div>
      <main class="research-view">${renderTab()}</main>
    `;
    bindEvents();
  };

  const tabButton = (id: ResearchWorkspaceTab, label: string, description: string): string => `
    <button type="button" class="research-tab ${tab === id ? 'is-active' : ''}" data-research-tab="${id}" role="tab" aria-selected="${tab === id}" aria-controls="research-tab-${id}">
      <strong>${label}</strong><span>${description}</span>
    </button>`;

  const renderTab = (): string => {
    if (tab === 'compare') return renderCompare();
    if (tab === 'notes') return renderNotes();
    if (tab === 'citations') return renderCitations();
    return renderLibrary();
  };

  const renderLibrary = (): string => {
    const papers = snapshot.papers;
    const selected = selectedPaperId ? snapshot.papers.find(paper => paper.paperId === selectedPaperId) : undefined;
    const candidates = duplicateCandidates();
    return `<section id="research-tab-library" role="tabpanel" class="research-tab-panel">
      <div class="research-grid research-grid--library">
        <section class="research-card research-card--wide">
          <div class="research-card-heading"><div><p class="research-label">COLLECTION</p><h2>Your papers <span class="research-count">${snapshot.papers.length}</span></h2></div><span class="research-state">${snapshot.evidenceBlocks.length} exact blocks</span></div>
          <label class="research-search"><span>Filter papers</span><input data-research-search type="search" placeholder="Title, author, DOI…"></label>
          <div class="research-paper-list" data-paper-list>
            ${papers.length ? papers.map(paper => renderPaperRow(paper)).join('') : '<p class="research-empty">No papers yet. Add a local record or import a bibliography below.</p>'}
          </div>
          ${candidates.length ? `<div class="research-duplicates"><div class="research-card-heading"><div><p class="research-label">REVIEW QUEUE</p><h3>Possible duplicates</h3></div><span class="research-state research-state--warning">Confirmation required</span></div>${candidates.map(renderDuplicate).join('')}</div>` : ''}
        </section>
        <section class="research-card">
          <p class="research-label">ADD LOCALLY</p><h2>New paper</h2><p class="research-help">Metadata stays unverified until you attach an exact local page/block source.</p>
          ${paperForm()}
        </section>
        <section class="research-card research-card--wide">
          <p class="research-label">BIBLIOGRAPHY EXCHANGE</p><h2>Import or export</h2><p class="research-help">BibTeX and RIS carry bibliography only. Evidence blocks and notes remain local JSON.</p>
          <form data-research-import class="research-inline-form">
            <label>Format<select name="format"><option value="bibtex">BibTeX</option><option value="ris">RIS</option></select></label>
            <label class="research-grow">Text<textarea name="text" rows="4" placeholder="Paste a local BibTeX or RIS record"></textarea></label>
            <button class="research-button research-button--primary" type="submit">Import records</button>
          </form>
          <div class="research-actions"><button type="button" class="research-button" data-export-format="bibtex">Export BibTeX</button><button type="button" class="research-button" data-export-format="ris">Export RIS</button></div>
        </section>
        ${selected ? renderPaperInspector(selected) : '<section class="research-card research-card--wide research-empty-panel"><h2>Inspect a paper</h2><p>Select a paper to attach exact evidence, notes, and references. Empty fields remain UNKNOWN instead of being filled in.</p></section>'}
      </div>
    </section>`;
  };

  const renderPaperRow = (paper: ResearchPaper): string => {
    const blocks = snapshot.evidenceBlocks.filter(block => block.paperId === paper.paperId);
    const status = blocks.length ? 'SUPPORTED' : 'UNVERIFIED';
    return `<article class="research-paper-row ${paper.paperId === selectedPaperId ? 'is-selected' : ''}" data-paper-search="${escapeAttr(`${paper.title} ${paper.authors.join(' ')} ${paper.doi ?? ''} ${paper.arxiv ?? ''}`)}">
      <button type="button" class="research-paper-open" data-select-paper="${escapeAttr(paper.paperId)}"><span class="research-paper-index">${escapeHtml((paper.year ?? '—').toString())}</span><span><strong>${escapeHtml(paper.title)}</strong><small>${escapeHtml(paper.authors.join(', ') || 'Author not supplied')} · ${escapeHtml(paper.paperId)}</small></span></button>
      <span class="research-chip research-chip--${status.toLowerCase()}">${status}</span>
    </article>`;
  };

  const renderDuplicate = (candidate: DuplicateCandidate): string => `<div class="research-duplicate"><div><strong>${escapeHtml(candidate.paperIds.join(' + '))}</strong><small>Matched by ${escapeHtml(candidate.reason)}. Nothing has been merged.</small></div><button type="button" class="research-button research-button--quiet" data-merge-duplicate="${escapeAttr(candidate.paperIds.join(','))}">Confirm merge</button></div>`;

  const renderPaperInspector = (paper: ResearchPaper): string => {
    const blocks = snapshot.evidenceBlocks.filter(block => block.paperId === paper.paperId).sort((left, right) => left.page - right.page || left.id.localeCompare(right.id));
    return `<section class="research-card research-card--wide research-inspector">
      <div class="research-card-heading"><div><p class="research-label">INSPECT PAPER</p><h2>${escapeHtml(paper.title)}</h2></div><span class="research-state">${escapeHtml(paper.metadataReceipts[0]?.status?.toUpperCase() ?? 'UNKNOWN')}</span></div>
      <dl class="research-meta"><div><dt>Paper id</dt><dd>${escapeHtml(paper.paperId)}</dd></div><div><dt>DOI / arXiv</dt><dd>${escapeHtml(paper.doi ?? paper.arxiv ?? 'UNKNOWN')}</dd></div><div><dt>Venue / year</dt><dd>${escapeHtml([paper.venue ?? 'UNKNOWN', paper.year ?? 'UNKNOWN'].join(' · '))}</dd></div><div><dt>Provenance</dt><dd>Local record · external enrichment is OFFLINE</dd></div></dl>
      <div class="research-inspector-grid"><section><h3>Exact evidence blocks <span>${blocks.length}</span></h3>${blocks.length ? `<ul class="research-evidence-list">${blocks.map(renderBlock).join('')}</ul><button type="button" class="research-button" data-download-study-pack="${escapeAttr(paper.paperId)}">Download evidence-linked study pack</button>` : '<p class="research-empty">No page/block evidence. Matrix cells will remain UNKNOWN or UNVERIFIED.</p>'}${evidenceForm(paper)}</section><section><h3>Citation references <span>${paper.references.length}</span></h3>${paper.references.length ? `<ul class="research-reference-list">${paper.references.map(reference => `<li><strong>${escapeHtml(reference.title ?? 'UNKNOWN')}</strong><small>${escapeHtml([reference.doi ?? 'no DOI', reference.year ?? 'no year'].join(' · '))}</small></li>`).join('')}</ul>` : '<p class="research-empty">No references supplied.</p>'}${referenceForm(paper)}</section></div>
    </section>`;
  };

  const renderBlock = (block: EvidenceBlock): string => `<li><div><strong>${escapeHtml(block.id)}</strong><small>Page ${block.page}${block.section ? ` · ${escapeHtml(block.section)}` : ''}</small></div><p>${escapeHtml(block.text)}</p><span class="research-chip research-chip--supported">SUPPORTED</span></li>`;

  const paperForm = (): string => `<form data-add-paper class="research-form"><label>Title<input name="title" required></label><label>Authors<input name="authors" placeholder="One author per line or use ;" required></label><div class="research-form-row"><label>Year<input name="year" type="number" min="1000" max="9999"></label><label>Venue<input name="venue"></label></div><label>DOI or arXiv<input name="identifier" placeholder="Optional, not fetched"></label><div class="research-form-row"><label>Topics<input name="topics" placeholder="comma separated"></label><label>Tags<input name="tags" placeholder="comma separated"></label></div><button class="research-button research-button--primary" type="submit">Add paper locally</button></form>`;

  const evidenceForm = (paper: ResearchPaper): string => `<form data-add-evidence class="research-form research-form--evidence"><input type="hidden" name="paperId" value="${escapeAttr(paper.paperId)}"><label>Block id<input name="id" required placeholder="p1-r1"></label><div class="research-form-row"><label>Page<input name="page" type="number" min="1" required></label><label>Section<input name="section" placeholder="Results"></label></div><label>Exact source text<textarea name="text" rows="4" required></textarea></label><label>Source hash<input name="sourceSha256" placeholder="Optional SHA-256 of immutable source"></label><button class="research-button" type="submit">Attach exact block</button></form>`;

  const referenceForm = (paper: ResearchPaper): string => `<form data-add-reference class="research-form"><input type="hidden" name="paperId" value="${escapeAttr(paper.paperId)}"><label>Reference title<input name="title" required></label><div class="research-form-row"><label>Year<input name="year" type="number" min="1000" max="9999"></label><label>DOI<input name="doi"></label></div><button class="research-button" type="submit">Add reference</button></form>`;

  const renderCompare = (): string => {
    const papers: ResearchMatrixPaper[] = snapshot.papers.map(paper => ({ paperId: paper.paperId, title: paper.title, blocks: snapshot.evidenceBlocks.filter(block => block.paperId === paper.paperId), metadata: {} }));
    const matrix = buildResearchMatrix(papers, ASPECTS);
    const paperMatrix = comparePapers(snapshot.papers.map(paper => ({ id: paper.paperId, title: paper.title, year: paper.year ?? 0, sections: sectionsFor(paper.paperId) })), PAPER_ASPECTS);
    const markdown = matrixToMarkdown(matrix);
    return `<section id="research-tab-compare" role="tabpanel" class="research-tab-panel"><div class="research-grid research-grid--single"><section class="research-card research-card--wide"><div class="research-card-heading"><div><p class="research-label">EVIDENCE MATRIX</p><h2>What the source supports</h2></div><div class="research-actions"><span class="research-state">${matrix.cells.length} supported · ${matrix.gaps.length} gaps</span><button type="button" class="research-button" data-download-matrix>Download Markdown</button></div></div>${renderResearchMatrix(matrix)}</section><section class="research-card research-card--wide"><div class="research-card-heading"><div><p class="research-label">PAPER COMPARISON</p><h2>Method / data / metrics</h2></div><span class="research-state">Quotes only</span></div>${renderPaperMatrix(paperMatrix)}${renderSummary(paperMatrix)}</section><details class="research-card research-card--wide"><summary>View matrix artifact</summary><pre class="research-artifact">${escapeHtml(markdown || 'No rows to compare.')}</pre></details></div></section>`;
  };

  const renderResearchMatrix = (matrix: ReturnType<typeof buildResearchMatrix>): string => {
    if (!matrix.rows.length || !matrix.columns.length) return '<p class="research-empty">Comparison refused: add at least one paper and one aspect.</p>';
    const cellByKey = new Map(matrix.cells.map(cell => [`${cell.paperId}:${cell.aspectId}`, cell]));
    const gapByKey = new Map(matrix.gaps.map(gap => [`${gap.paperId}:${gap.aspectId}`, gap]));
    return `<div class="research-table-wrap"><table class="research-table"><thead><tr><th>Paper</th>${matrix.columns.map(column => `<th>${escapeHtml(column.label)}</th>`).join('')}</tr></thead><tbody>${matrix.rows.map(row => `<tr><th scope="row">${escapeHtml(row.title)}</th>${matrix.columns.map(column => { const cell = cellByKey.get(`${row.paperId}:${column.aspectId}`); const gap = gapByKey.get(`${row.paperId}:${column.aspectId}`); return `<td>${cell ? `<span class="research-chip research-chip--supported">SUPPORTED</span><p>${escapeHtml(cell.text)}</p><small>p.${cell.evidence.anchor?.page ?? '?'} · ${escapeHtml(cell.evidence.anchor?.blockId ?? 'UNKNOWN')}</small>` : `<span class="research-chip research-chip--unknown">${gap?.status.toUpperCase() ?? 'UNKNOWN'}</span><p>${escapeHtml(gap?.reason ?? 'No local evidence was supplied.')}</p>`}</td>`; }).join('')}</tr>`).join('')}</tbody></table></div>`;
  };

  const renderPaperMatrix = (matrix: ReturnType<typeof comparePapers>): string => {
    if (!matrix.rows.length || !matrix.aspects.length) return '<p class="research-empty">Comparison refused until papers and searchable aspects exist.</p>';
    const cells = new Map(matrix.cells.map(cell => [`${cell.paperId}:${cell.aspectId}`, cell]));
    const gaps = new Map(matrix.gaps.map(gap => [`${gap.paperId}:${gap.aspectId}`, gap]));
    return `<div class="research-table-wrap"><table class="research-table research-table--quotes"><thead><tr><th>Paper</th><th>Year</th>${matrix.aspects.map(aspect => `<th>${escapeHtml(aspect.label)}</th>`).join('')}</tr></thead><tbody>${matrix.rows.map(row => `<tr><th scope="row">${escapeHtml(row.title)}</th><td>${row.year || 'UNKNOWN'}</td>${matrix.aspects.map(aspect => { const cell = cells.get(`${row.paperId}:${aspect.aspectId}`); const gap = gaps.get(`${row.paperId}:${aspect.aspectId}`); return `<td>${cell ? `<p>“${escapeHtml(cell.text)}”</p><small>${escapeHtml(cell.section || '(untitled section)')} · score ${cell.score}</small>` : `<span class="research-chip research-chip--unknown">${gap?.reason === 'no-sections' ? 'UNVERIFIED' : 'UNKNOWN'}</span>`}</td>`; }).join('')}</tr>`).join('')}</tbody></table></div>`;
  };

  const renderSummary = (matrix: ReturnType<typeof comparePapers>): string => {
    const summary = summarise(matrix);
    const lines = summary.aspects.flatMap(aspect => [aspect.consensus, aspect.divergence].filter((value): value is string => Boolean(value)));
    return lines.length ? `<ul class="research-summary">${lines.map(line => `<li>${escapeHtml(line)}</li>`).join('')}</ul>` : '<p class="research-empty">No consensus or divergence is reported from a single witness.</p>';
  };

  const renderNotes = (): string => {
    const notes = snapshot.notes;
    return `<section id="research-tab-notes" role="tabpanel" class="research-tab-panel"><div class="research-grid research-grid--notes"><section class="research-card"><p class="research-label">ANNOTATION</p><h2>New note</h2><p class="research-help">A note cannot be saved without an evidence reference. Unknown anchors remain visibly orphaned.</p>${noteForm()}</section><section class="research-card research-card--wide"><div class="research-card-heading"><div><p class="research-label">LOCAL NOTES</p><h2>Notes <span class="research-count">${notes.length}</span></h2></div><span class="research-state">${notes.filter(note => !note.orphaned).length} anchored</span></div>${notes.length ? `<ul class="research-note-list">${notes.map(note => `<li><div class="research-note-heading"><strong>${escapeHtml(note.kind.toUpperCase())}</strong><span class="research-chip research-chip--${note.orphaned ? 'unknown' : 'supported'}">${note.orphaned ? 'ORPHANED' : 'ANCHORED'}</span></div><p>${escapeHtml(note.text)}</p><small>${escapeHtml(note.paperId)} · ${escapeHtml(note.anchors[0]?.status.toUpperCase() ?? 'UNKNOWN')} · p.${note.anchors[0]?.anchor?.page ?? '?'}/${escapeHtml(note.anchors[0]?.anchor?.blockId ?? 'no-block')}</small></li>`).join('')}</ul>` : '<p class="research-empty">No notes yet.</p>'}</section></div></section>`;
  };

  const noteForm = (): string => `<form data-add-note class="research-form"><label>Paper<select name="paperId" required>${paperOptions()}</select></label><div class="research-form-row"><label>Kind<select name="kind"><option value="note">Note</option><option value="question">Question</option><option value="claim">Claim</option><option value="highlight">Highlight</option><option value="bookmark">Bookmark</option></select></label><label>Page<input name="page" type="number" min="1" required></label></div><label>Block id<input name="blockId" placeholder="p1-r1"></label><label>Exact quote<textarea name="quote" rows="3" placeholder="Must match a supplied block for SUPPORTED"></textarea></label><label>Note text<textarea name="text" rows="4" required></textarea></label><button class="research-button research-button--primary" type="submit">Save note</button></form>`;

  const renderCitations = (): string => {
    const citationPapers: CitationPaper[] = snapshot.papers.map(paper => ({ id: paper.paperId, title: paper.title, year: paper.year, doi: paper.doi, references: paper.references.map(reference => ({ doi: reference.doi, title: reference.title, year: reference.year })) }));
    const graph = buildGraph(citationPapers);
    const missing = missingReferences(graph);
    return `<section id="research-tab-citations" role="tabpanel" class="research-tab-panel"><div class="research-grid research-grid--single"><section class="research-card research-card--wide"><p class="research-label">ANSWER INSPECTOR</p><h2>Parse citation markers</h2><form data-parse-citations class="research-form"><label>Paper source<select name="paperId" required>${paperOptions()}</select></label><p class="research-help">Citation support is checked against both this paper and its exact page/block evidence.</p><label>Answer text<textarea name="answer" rows="4" placeholder="A supported statement [p1:r2]. An unresolved claim [p99]."></textarea></label><button class="research-button research-button--primary" type="submit"${snapshot.papers.length ? '' : ' disabled'}>Inspect citations</button></form><div data-citation-result class="research-citation-result"><p class="research-empty">No answer inspected yet.</p></div></section><section class="research-card research-card--wide"><div class="research-card-heading"><div><p class="research-label">LOCAL CITATION GRAPH</p><h2>Paper relationships</h2></div><span class="research-state">${graph.stats.papers} papers · ${graph.stats.stubs} stubs</span></div><div class="research-stat-grid"><div><strong>${graph.stats.resolvedEdges}</strong><span>resolved edges</span></div><div><strong>${graph.stats.unresolvedEdges}</strong><span>unresolved references</span></div><div><strong>${missing.length}</strong><span>missing works</span></div></div>${graph.nodes.length ? `<ul class="research-graph-list">${graph.nodes.map(node => `<li><span class="research-chip research-chip--${node.kind === 'paper' ? 'supported' : 'unknown'}">${node.kind === 'paper' ? 'PAPER' : 'STUB'}</span><div><strong>${escapeHtml(node.title || 'UNKNOWN WORK')}</strong><small>${escapeHtml(node.id)}${node.doi ? ` · ${escapeHtml(node.doi)}` : ''}</small></div></li>`).join('')}</ul>` : '<p class="research-empty">Add references in the Library inspector to build the local graph.</p>'}</section></div></section>`;
  };

  const paperOptions = (): string => snapshot.papers.length ? snapshot.papers.map(paper => `<option value="${escapeAttr(paper.paperId)}"${paper.paperId === selectedPaperId ? ' selected' : ''}>${escapeHtml(paper.title)}</option>`).join('') : '<option value="" disabled selected>Add a paper first</option>';

  const sectionsFor = (paperId: string) => {
    const blocks = snapshot.evidenceBlocks.filter(block => block.paperId === paperId);
    const groups = new Map<string, string[]>();
    for (const block of blocks) {
      const name = block.section?.trim() || 'Evidence';
      const values = groups.get(name) ?? [];
      values.push(block.text);
      groups.set(name, values);
    }
    return [...groups.entries()].map(([name, text]) => ({ name, text: text.join(' ') }));
  };

  const duplicateCandidates = (): DuplicateCandidate[] => {
    const library = new ResearchLibrary({ now });
    for (const paper of snapshot.papers) {
      try { library.addPaper(paper); } catch { /* malformed persisted records are ignored by the UI */ }
    }
    return library.proposeDuplicates();
  };

  const bindEvents = (): void => {
    root.querySelectorAll<HTMLButtonElement>('[data-research-tab]').forEach(button => button.addEventListener('click', () => {
      const next = button.dataset.researchTab as ResearchWorkspaceTab | undefined;
      if (next) { tab = next; render(); }
    }));
    root.querySelectorAll<HTMLButtonElement>('[data-select-paper]').forEach(button => button.addEventListener('click', () => {
      selectedPaperId = button.dataset.selectPaper;
      snapshot = { ...snapshot, activePaperId: selectedPaperId };
      persist();
      render();
    }));
    root.querySelector<HTMLInputElement>('[data-research-search]')?.addEventListener('input', event => {
      const query = String((event.currentTarget as HTMLInputElement).value).trim().toLocaleLowerCase();
      root.querySelectorAll<HTMLElement>('[data-paper-search]').forEach(row => {
        row.hidden = query.length > 0 && !row.dataset.paperSearch!.toLocaleLowerCase().includes(query);
      });
    });
    root.querySelector<HTMLFormElement>('[data-add-paper]')?.addEventListener('submit', event => { event.preventDefault(); addPaper(new FormData(event.currentTarget as HTMLFormElement)); });
    root.querySelector<HTMLFormElement>('[data-add-evidence]')?.addEventListener('submit', event => { event.preventDefault(); addEvidence(new FormData(event.currentTarget as HTMLFormElement)); });
    root.querySelector<HTMLFormElement>('[data-add-reference]')?.addEventListener('submit', event => { event.preventDefault(); addReference(new FormData(event.currentTarget as HTMLFormElement)); });
    root.querySelector<HTMLFormElement>('[data-add-note]')?.addEventListener('submit', event => { event.preventDefault(); addNote(new FormData(event.currentTarget as HTMLFormElement)); });
    root.querySelector<HTMLFormElement>('[data-research-import]')?.addEventListener('submit', event => { event.preventDefault(); importRecords(new FormData(event.currentTarget as HTMLFormElement)); });
    root.querySelectorAll<HTMLButtonElement>('[data-export-format]').forEach(button => button.addEventListener('click', () => exportRecords(button.dataset.exportFormat === 'ris' ? 'ris' : 'bibtex')));
    root.querySelectorAll<HTMLButtonElement>('[data-merge-duplicate]').forEach(button => button.addEventListener('click', () => mergeDuplicate(button.dataset.mergeDuplicate ?? '')));
    root.querySelector<HTMLButtonElement>('[data-download-matrix]')?.addEventListener('click', () => downloadText('research-matrix.md', matrixToMarkdown(buildResearchMatrix(snapshot.papers.map(paper => ({ paperId: paper.paperId, title: paper.title, blocks: snapshot.evidenceBlocks.filter(block => block.paperId === paper.paperId), metadata: {} })), ASPECTS)), 'text/markdown;charset=utf-8'));
    root.querySelector<HTMLFormElement>('[data-parse-citations]')?.addEventListener('submit', event => { event.preventDefault(); inspectCitations(new FormData(event.currentTarget as HTMLFormElement)); });
    root.querySelectorAll<HTMLButtonElement>('[data-download-study-pack]').forEach(button => button.addEventListener('click', () => downloadStudyPack(button.dataset.downloadStudyPack ?? '')));
  };

  const addPaper = (form: FormData): void => {
    const title = textValue(form, 'title');
    if (!title) { setMessage('A paper title is required.', 'error'); render(); return; }
    const paperId = `paper-${slug(title)}-${Date.now().toString(36)}`;
    const identifier = textValue(form, 'identifier');
    const paper: ResearchPaper = {
      paperId,
      title,
      authors: splitPeople(textValue(form, 'authors')),
      ...(identifier.startsWith('10.') ? { doi: identifier } : identifier ? { arxiv: identifier } : {}),
      ...(numberValue(form, 'year') ? { year: numberValue(form, 'year') } : {}),
      ...(textValue(form, 'venue') ? { venue: textValue(form, 'venue') } : {}),
      topics: splitList(textValue(form, 'topics')),
      tags: splitList(textValue(form, 'tags')),
      references: [],
      metadataReceipts: [{ provider: 'manual', status: 'offline', fields: ['title', 'authors'], reason: 'Entered locally; no external enrichment was requested.' }],
      sourceHistory: [{ action: 'created', at: now(), source: 'manual' }],
      rawImports: [],
    };
    snapshot = { ...snapshot, papers: [...snapshot.papers, paper], activePaperId: paperId };
    selectedPaperId = paperId;
    persist();
    setMessage(`Added ${title}. Attach an exact page/block before treating it as supported.`);
    render();
  };

  const addEvidence = (form: FormData): void => {
    const paperId = textValue(form, 'paperId');
    const id = textValue(form, 'id');
    const page = numberValue(form, 'page');
    const text = textValue(form, 'text');
    if (!paperId || !id || !page || !text) { setMessage('Evidence needs a paper, block id, page, and exact source text.', 'error'); render(); return; }
    if (snapshot.evidenceBlocks.some(block => block.id === id && block.paperId === paperId)) { setMessage(`Block ${id} already exists for this paper.`, 'error'); render(); return; }
    const block: EvidenceBlock = { id, paperId, page, text, ...(textValue(form, 'section') ? { section: textValue(form, 'section') } : {}), ...(textValue(form, 'sourceSha256') ? { sourceSha256: textValue(form, 'sourceSha256') } : {}) };
    snapshot = { ...snapshot, evidenceBlocks: [...snapshot.evidenceBlocks, block] };
    persist(); setMessage(`Attached exact evidence ${id} on page ${page}.`); render();
  };

  const addReference = (form: FormData): void => {
    const paperId = textValue(form, 'paperId');
    const title = textValue(form, 'title');
    if (!paperId || !title) { setMessage('A reference title is required.', 'error'); render(); return; }
    snapshot = { ...snapshot, papers: snapshot.papers.map(paper => paper.paperId !== paperId ? paper : { ...paper, references: [...paper.references, { id: `ref-${paper.references.length + 1}`, title, ...(textValue(form, 'doi') ? { doi: textValue(form, 'doi') } : {}), ...(numberValue(form, 'year') ? { year: numberValue(form, 'year') } : {}) }] }) };
    persist(); setMessage('Reference added. The citation graph now records the local claim.'); render();
  };

  const addNote = (form: FormData): void => {
    const paperId = textValue(form, 'paperId');
    const page = numberValue(form, 'page');
    const blockId = textValue(form, 'blockId');
    const quote = textValue(form, 'quote');
    const text = textValue(form, 'text');
    if (!paperId || !page || !text) { setMessage('A note needs a paper, page, and note text.', 'error'); render(); return; }
    const block = snapshot.evidenceBlocks.find(candidate => candidate.paperId === paperId && candidate.page === page && (!blockId || candidate.id === blockId) && (!quote || candidate.text === quote));
    const anchors = [block ? supportedEvidence(block) : unknownEvidence(blockId ? `No exact local block ${blockId} matched this page and quote.` : 'No exact local page/block evidence was supplied.')];
    const store = new ResearchNoteStore({ now });
    if (snapshot.notes.length) store.importJson(JSON.stringify({ version: 1, notes: snapshot.notes }));
    const note = store.add({ paperId, text, kind: (textValue(form, 'kind') || 'note') as 'note', anchors });
    snapshot = { ...snapshot, notes: [...store.list()], activePaperId: paperId };
    selectedPaperId = paperId; persist(); setMessage(`${note.orphaned ? 'Saved as ORPHANED' : 'Saved anchored'} note ${note.noteId}.`); render();
  };

  const importRecords = (form: FormData): void => {
    const format = textValue(form, 'format') === 'ris' ? 'ris' : 'bibtex';
    const input = textValue(form, 'text');
    if (!input) { setMessage('Paste a local BibTeX or RIS record first.', 'error'); render(); return; }
    try {
      const parsed = importBibliography(input, format);
      const incoming = parsed.entries.map((entry, index) => paperFromEntry(entry, index, format, now()));
      snapshot = { ...snapshot, papers: [...snapshot.papers, ...incoming.filter(paper => !snapshot.papers.some(existing => existing.paperId === paper.paperId))] };
      persist(); setMessage(`Imported ${incoming.length} ${format.toUpperCase()} record(s); ${parsed.errors.length} parse issue(s) remain visible in the local result.`); render();
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error), 'error'); render(); }
  };

  const exportRecords = (format: 'bibtex' | 'ris'): void => {
    const text = exportBibliography(snapshot.papers.map(researchPaperToEntry), format);
    downloadText(`research-library.${format === 'bibtex' ? 'bib' : 'ris'}`, text, 'text/plain;charset=utf-8');
    setMessage(`Exported ${snapshot.papers.length} record(s) as ${format.toUpperCase()}.`); render();
  };

  const mergeDuplicate = (idsText: string): void => {
    const ids = idsText.split(',').filter(Boolean);
    const candidate = duplicateCandidates().find(item => item.paperIds.every(id => ids.includes(id)) && ids.length === item.paperIds.length);
    if (!candidate) { setMessage('Duplicate proposal is stale or unavailable.', 'error'); render(); return; }
    const library = new ResearchLibrary({ now });
    for (const paper of snapshot.papers) { try { library.addPaper(paper); } catch { /* ignored */ } }
    try {
      const result = library.mergeDuplicate(candidate, true);
      const removed = new Set(result.removedPaperIds);
      const remappedBlocks = snapshot.evidenceBlocks.map(block => removed.has(block.paperId) ? { ...block, paperId: result.keptPaperId } : block);
      const seenBlocks = new Set<string>();
      snapshot = { ...snapshot, papers: library.listPapers(), evidenceBlocks: remappedBlocks.filter(block => !seenBlocks.has(`${block.paperId}:${block.id}`) && seenBlocks.add(`${block.paperId}:${block.id}`)) };
      selectedPaperId = result.keptPaperId; persist(); setMessage(`Merged ${result.removedPaperIds.length} duplicate record(s) after confirmation.`); render();
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error), 'error'); render(); }
  };

  const inspectCitations = (form: FormData): void => {
    const paperId = textValue(form, 'paperId');
    const parsed = parseCitations(textValue(form, 'answer'));
    const target = root.querySelector<HTMLElement>('[data-citation-result]');
    if (!target) return;
    if (!snapshot.papers.some(paper => paper.paperId === paperId)) { setMessage('Choose a paper before inspecting citation support.', 'error'); render(); return; }
    target.innerHTML = `<div class="research-citation-clean"><span class="research-label">CLEANED ANSWER</span><p>${escapeHtml(parsed.cleaned || 'UNKNOWN')}</p></div>${parsed.citations.length ? `<ul class="research-citation-list">${parsed.citations.map(citation => { const support = resolveResearchCitationSupport(citation, paperId, snapshot.evidenceBlocks); return `<li><span class="research-chip research-chip--${support.status === 'supported' ? 'supported' : 'unknown'}">${support.status.toUpperCase()}</span><div><strong>${escapeHtml(citation.raw)}</strong><small>${escapeHtml(citation.blockId ?? 'Page-level citation only')} · ${escapeHtml(support.reason ?? `Paper ${paperId}`)} · repeated ${citation.count}×</small></div></li>`; }).join('')}</ul>` : '<p class="research-empty">No citation marker was recognised.</p>'}`;
  };

  const downloadStudyPack = (paperId: string): void => {
    const paper = snapshot.papers.find(candidate => candidate.paperId === paperId);
    if (!paper) { setMessage('The selected paper is no longer available.', 'error'); render(); return; }
    const blocks = snapshot.evidenceBlocks.filter(block => block.paperId === paperId);
    if (!blocks.length) { setMessage('A study pack needs exact local evidence blocks.', 'error'); render(); return; }
    const pack = buildStudyPack({ packId: `study-${slug(paperId)}`, paperId, title: `${paper.title} study pack`, blocks });
    downloadText(`${slug(paper.title)}-study-pack.json`, toStudyPackJson(pack), 'application/json;charset=utf-8');
    setMessage(`Exported an evidence-linked study pack from ${pack.derivedFrom.length} exact block(s).`);
    render();
  };

  render();
  return { destroy: () => { container.replaceChildren(); } };
}

function paperFromEntry(entry: { key: string; fields: Record<string, string> }, index: number, format: 'bibtex' | 'ris', importedAt: string): ResearchPaper {
  const field = (name: string): string => entry.fields[name] ?? entry.fields[name.toLowerCase()] ?? '';
  const identifier = field('doi');
  return {
    paperId: `import:${entry.key || `${format}-${index + 1}`}`,
    title: field('title') || `Imported record ${index + 1}`,
    authors: (field('author') || '').split(/\s+and\s+|;/u).map(value => value.trim()).filter(Boolean),
    ...(identifier ? { doi: identifier } : {}),
    ...(Number(field('year')) ? { year: Number(field('year')) } : {}),
    ...(field('journal') ? { venue: field('journal') } : {}),
    ...(field('abstract') ? { abstract: field('abstract') } : {}),
    topics: [], tags: field('keywords').split(',').map(value => value.trim()).filter(Boolean), references: [],
    metadataReceipts: [{ provider: format, status: 'offline', fields: ['title', 'authors'], reason: 'Imported from a local bibliography string; no provider was contacted.' }],
    sourceHistory: [{ action: 'imported', at: importedAt, source: format }],
    rawImports: [{ format, importedAt, source: format, unknownFields: {} }],
    citationKey: entry.key || undefined,
  };
}

function textValue(form: FormData, key: string): string { return String(form.get(key) ?? '').trim(); }
function numberValue(form: FormData, key: string): number | undefined { const value = Number(textValue(form, key)); return Number.isInteger(value) && value > 0 ? value : undefined; }
function splitList(value: string): string[] { return [...new Set(value.split(',').map(item => item.trim()).filter(Boolean))]; }
function splitPeople(value: string): string[] { return [...new Set(value.split(/\r?\n|;/u).map(item => item.trim()).filter(Boolean))]; }
function slug(value: string): string { return value.toLocaleLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '').slice(0, 48) || 'paper'; }
function escapeHtml(value: unknown): string { return String(value).replace(/[&<>"']/gu, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] ?? char)); }
function escapeAttr(value: unknown): string { return escapeHtml(value); }
function downloadText(name: string, text: string, type: string): void { const blob = new Blob([text], { type }); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = name; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 0); }
