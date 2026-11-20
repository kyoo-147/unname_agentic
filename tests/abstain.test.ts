import { describe, expect, it } from 'vitest';
import {
  ABSTAIN_COVERAGE_FLOOR,
  ABSTAIN_LANGUAGES,
  ANSWER_COVERAGE_FLOOR,
  BEST_BLOCK_COVERAGE_FLOOR,
  DEFAULT_ABSTAIN_LANGUAGE,
  abstainMessage,
  assessEvidence,
  guardAnswer,
  type AbstainLanguage,
  type EvidenceAssessment,
} from '../src/core/abstain';
import { buildDocument } from '../src/core/ir';
import { planContext, type ContextBlock, type WorkspaceDocument } from '../src/core/multi-document';

const SHA = 'a'.repeat(64);

/**
 * One document with one block per page. `planContext` chunks per page, so a page is the
 * unit a context block carries and this helper keeps the fixtures readable.
 */
function makeDocument(id: string, pages: readonly string[]): WorkspaceDocument {
  return {
    id,
    title: `${id} report`,
    ir: buildDocument({
      documentId: id,
      sourceSha256: SHA,
      blocks: pages.map((text, index) => ({
        page: index + 1,
        text,
        rect: { x: 72, y: 72, width: 468, height: 20 },
      })),
      pages: pages.map((_text, index) => ({ index: index + 1, width: 612, height: 792 })),
    }),
  };
}

/** The context `planContext` plans for `question` over a one-document workspace. */
function contextFor(question: string, pages: readonly string[]): ContextBlock[] {
  return planContext({ documents: [makeDocument('alpha', pages)] }, question);
}

const LIGHTHOUSE_QUESTION = 'What is the lighthouse maintenance budget?';

describe('assessEvidence', () => {
  it('answers a question the planned context fully covers', () => {
    const question = LIGHTHOUSE_QUESTION;
    const context = contextFor(question, [
      'The lighthouse maintenance budget is 12,000 units per year.',
      'Lighthouse maintenance budget changes are reviewed every spring.',
    ]);

    expect(context.length).toBe(2);
    const assessment = assessEvidence(question, context);
    expect(assessment.verdict).toBe('answer');
    expect(assessment.coverage).toBe(1);
    expect(assessment.missing).toEqual([]);
    expect(assessment.reasons).toEqual([]);
  });

  it('calls a question whose terms appear only once in the context weak', () => {
    const question = 'What did the contractor say about the lighthouse maintenance budget?';
    const context = contextFor(question, [
      'The lighthouse maintenance budget is 1,200 units, reviewed each spring.',
    ]);

    // Three of the five terms occur, each exactly once: enough for a caution, not an answer.
    const assessment = assessEvidence(question, context);
    expect(assessment.verdict).toBe('weak');
    expect(assessment.coverage).toBe(0.6);
    expect(assessment.missing).toEqual(['contractor', 'say']);
    expect(assessment.reasons).toEqual(['partial-coverage']);
  });

  it('abstains on a numeric question whose context carries no figure', () => {
    const question = 'How many pages does the lighthouse report have?';
    const context = contextFor(question, ['The lighthouse report lists pages of maintenance notes.']);

    // Every term is present, which is why coverage alone would have answered: the missing
    // signal is the figure, and the verdict has to come from that.
    const assessment = assessEvidence(question, context);
    expect(assessment.verdict).toBe('abstain');
    expect(assessment.coverage).toBe(1);
    expect(assessment.missing).toEqual([]);
    expect(assessment.reasons).toEqual(['number-question-without-figure']);
  });

  it('abstains with the empty-context reason when nothing was retrieved', () => {
    const question = LIGHTHOUSE_QUESTION;
    const context = contextFor(question, ['Quarterly tax filing compliance is due in April.']);

    expect(context).toEqual([]);
    const assessment = assessEvidence(question, context);
    expect(assessment.verdict).toBe('abstain');
    expect(assessment.coverage).toBe(0);
    expect(assessment.reasons).toEqual(['empty-context']);
    expect(assessment.missing).toEqual(['lighthouse', 'maintenance', 'budget']);
  });

  it('abstains on a question made only of function words', () => {
    const context = contextFor('What is the lighthouse budget?', ['The lighthouse budget is fixed.']);
    expect(context.length).toBeGreaterThan(0);

    const assessment = assessEvidence('What is it?', context);
    expect(assessment.verdict).toBe('abstain');
    expect(assessment.reasons).toEqual(['no-query-terms']);
    expect(assessment.missing).toEqual([]);

    expect(assessEvidence('', context).reasons).toEqual(['no-query-terms']);
  });

  it('calls fragmented evidence weak rather than answerable', () => {
    const question = 'What is the lighthouse maintenance budget total?';
    const context = contextFor(question, [
      'The lighthouse stands on the north coast.',
      'Maintenance happens every spring.',
      'The budget was approved by the board.',
      'The total reaches 12,000 units.',
    ]);

    // Every term is present, but each on its own page: no sentence supports the question.
    expect(context.length).toBe(4);
    const assessment = assessEvidence(question, context);
    expect(assessment.coverage).toBe(1);
    expect(assessment.verdict).toBe('weak');
    expect(assessment.reasons).toEqual(['fragmented-evidence']);
  });

  it('abstains on a yes or no question the context cannot settle', () => {
    const question = 'Does the lighthouse report mention maintenance costs?';
    const context = contextFor(question, [
      'The lighthouse report is three pages long.',
      'Maintenance costs are listed by quarter.',
      'They mention the appendix.',
    ]);

    expect(context.length).toBe(3);
    const assessment = assessEvidence(question, context);
    expect(assessment.verdict).toBe('abstain');
    expect(assessment.reasons).toEqual(['polar-question-unconfirmed', 'fragmented-evidence']);
  });

  it('reports the coverage gap before the missing figure', () => {
    const question = 'How many pages and words does the lighthouse report contain?';
    const context = contextFor(question, ['The lighthouse stands on the coast.']);

    // One term of five, and the question also asks for a number: the honest first reason
    // is that the context hardly speaks to the question, not that a figure is absent.
    expect(assessEvidence(question, context).reasons).toEqual(['low-coverage']);
  });

  it('folds Vietnamese diacritics on both sides of the match', () => {
    const question = 'Chi phí bảo trì là bao nhiêu?';
    const context = contextFor(question, ['Chi phi bao tri la 1200 USD.']);

    // The question carries the accents and the context does not: coverage has to see the
    // same three terms, and the figure the question asks for is there.
    const assessment = assessEvidence(question, context);
    expect(assessment.coverage).toBe(1);
    expect(assessment.verdict).toBe('answer');
  });

  it('keeps the thresholds in the order the checks rely on', () => {
    expect(ABSTAIN_COVERAGE_FLOOR).toBeLessThan(ANSWER_COVERAGE_FLOOR);
    expect(BEST_BLOCK_COVERAGE_FLOOR).toBeLessThanOrEqual(ANSWER_COVERAGE_FLOOR);
  });
});

describe('abstainMessage', () => {
  it('writes a distinct sentence per language for weak and abstain', () => {
    for (const verdict of ['weak', 'abstain'] as const) {
      const texts = ABSTAIN_LANGUAGES.map(language => abstainMessage(verdict, language));
      expect(texts).toHaveLength(3);
      for (const text of texts) {
        expect(text.trim().length).toBeGreaterThan(20);
        expect(text).not.toContain('{');
      }
      expect(new Set(texts).size).toBe(3);
    }
  });

  it('says nothing for an answer and falls back for an unknown language', () => {
    expect(abstainMessage('answer', 'en')).toBe('');
    expect(abstainMessage('abstain', 'fr' as AbstainLanguage)).toBe(
      abstainMessage('abstain', DEFAULT_ABSTAIN_LANGUAGE),
    );
  });
});

describe('guardAnswer', () => {
  it('refuses an uncited answer that the evidence does not support', () => {
    const assessment = assessEvidence(
      LIGHTHOUSE_QUESTION,
      contextFor(LIGHTHOUSE_QUESTION, ['Quarterly tax filing compliance is due in April.']),
    );
    expect(assessment.verdict).toBe('abstain');

    expect(guardAnswer('The lighthouse budget is 40,000 units.', assessment)).toEqual({
      ok: false,
      reason: 'uncited-answer-without-evidence',
    });
  });

  it('lets a cited answer through even under an abstain verdict', () => {
    const assessment: EvidenceAssessment = {
      verdict: 'abstain',
      coverage: 0.2,
      reasons: ['low-coverage'],
      missing: ['budget'],
    };

    expect(guardAnswer('The budget is 40,000 units [[doc:alpha page 2]].', assessment).ok).toBe(true);
    expect(guardAnswer('The budget is 40,000 units [p2].', assessment).ok).toBe(true);
  });

  it('lets an uncited answer through when coverage is high', () => {
    const assessment: EvidenceAssessment = {
      verdict: 'abstain',
      coverage: 1,
      reasons: ['number-question-without-figure'],
      missing: [],
    };

    expect(guardAnswer('It is 40,000 units.', assessment)).toEqual({ ok: true, answer: 'It is 40,000 units.' });
  });

  it('lets an answer through under an answer or weak verdict', () => {
    const answer: EvidenceAssessment = { verdict: 'answer', coverage: 1, reasons: [], missing: [] };
    expect(guardAnswer('It is 40,000 units.', answer).ok).toBe(true);

    const weak: EvidenceAssessment = {
      verdict: 'weak',
      coverage: 0.6,
      reasons: ['partial-coverage'],
      missing: ['say'],
    };
    expect(guardAnswer('It is 40,000 units.', weak).ok).toBe(true);
  });
});
