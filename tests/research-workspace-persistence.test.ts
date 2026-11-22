import { describe, expect, it } from 'vitest';
import { ResearchWorkspacePersistence, RESEARCH_WORKSPACE_VERSION, serializeResearchWorkspace, type ResearchWorkspaceSnapshot } from '../src/core/research/workspace';

function storage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    raw: (key: string) => values.get(key),
  };
}

const paper = {
  paperId: 'paper-1',
  title: 'Local evidence',
  authors: ['A. Researcher'],
  topics: ['offline'],
  tags: ['seed'],
  references: [],
  metadataReceipts: [{ provider: 'manual' as const, status: 'offline' as const, fields: ['title'] }],
  sourceHistory: [{ action: 'created' as const, at: '2026-01-01T00:00:00.000Z', source: 'manual' as const }],
  rawImports: [],
};

describe('research workspace persistence', () => {
  it('round-trips papers, exact blocks, notes and active paper locally', () => {
    const snapshot: ResearchWorkspaceSnapshot = {
      version: RESEARCH_WORKSPACE_VERSION,
      papers: [paper],
      evidenceBlocks: [{ id: 'p1-r1', paperId: 'paper-1', page: 1, text: 'The source says this.', section: 'Results' }],
      notes: [{
        noteId: 'rn1', paperId: 'paper-1', text: 'Check this claim.', kind: 'question', citationIds: [],
        anchors: [{ status: 'supported', anchor: { paperId: 'paper-1', page: 1, blockId: 'p1-r1', quote: 'The source says this.', anchorKind: 'block' } }],
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', orphaned: false,
      }],
      activePaperId: 'paper-1',
    };
    const local = storage();
    const persistence = new ResearchWorkspacePersistence({ storage: local });
    expect(persistence.save(snapshot)).toBe(true);
    const loaded = persistence.load();
    expect(loaded).toEqual(snapshot);
    loaded.papers[0]!.tags.push('changed');
    expect(persistence.load().papers[0]!.tags).toEqual(['seed']);
  });

  it('fails closed to an empty workspace for malformed or stale data', () => {
    const local = storage({ 'mirror.research-workspace.v1': '{not-json' });
    const persistence = new ResearchWorkspacePersistence({ storage: local });
    expect(persistence.load()).toEqual({ version: 1, papers: [], evidenceBlocks: [], notes: [] });
    local.setItem('mirror.research-workspace.v1', JSON.stringify({ version: 99, papers: [paper] }));
    expect(persistence.load().papers).toEqual([]);
  });

  it('serializes a stable versioned artifact with a trailing newline', () => {
    const text = serializeResearchWorkspace({ version: 1, papers: [], evidenceBlocks: [], notes: [] });
    expect(text.endsWith('\n')).toBe(true);
    expect(JSON.parse(text)).toEqual({ version: 1, papers: [], evidenceBlocks: [], notes: [] });
  });
});
