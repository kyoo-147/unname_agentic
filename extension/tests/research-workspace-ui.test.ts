import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../viewer/src/ui/research-workspace.ts', import.meta.url), 'utf8');

describe('research workspace UI wiring', () => {
  it('binds paper selection once', () => {
    expect(source.match(/querySelectorAll<HTMLButtonElement>\('\[data-select-paper\]'\)/gu)).toHaveLength(1);
  });

  it('requires a paper identity and delegates citation status to paper-scoped evidence matching', () => {
    expect(source).toContain('<select name="paperId" required>${paperOptions()}</select>');
    expect(source).toContain('resolveResearchCitationSupport(citation, paperId, snapshot.evidenceBlocks)');
    expect(source).not.toContain('snapshot.evidenceBlocks.some(block => block.id === citation.blockId)');
  });

  it('connects the local evidence-backed study pack export flow', () => {
    expect(source).toContain('data-download-study-pack');
    expect(source).toContain('buildStudyPack({ packId: `study-${slug(paperId)}`');
    expect(source).toContain('toStudyPackJson(pack)');
  });
});
