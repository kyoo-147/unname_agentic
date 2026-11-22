import { toCsv, toMarkdown, type Table } from '../core/tables';
import { segmentText, toLatex, type Segment } from '../core/formulas';

export interface FormulaExport {
  source: string;
  latex: string;
  kind: 'inline-math' | 'display-math';
}

export interface StructuredExportResult {
  format: 'csv' | 'markdown' | 'latex';
  text: string;
  lossy: boolean;
  limitations: string[];
}

/** Export a recovered table without inventing missing cells. */
export function exportTableCsv(table: Table): StructuredExportResult {
  return { format: 'csv', text: toCsv(table), lossy: table.spans.length > 0, limitations: table.spans.length > 0 ? ['Merged cells are represented as one CSV value; CSV has no native span semantics.'] : [] };
}

/** Export a recovered table for human review. */
export function exportTableMarkdown(table: Table): StructuredExportResult {
  return { format: 'markdown', text: toMarkdown(table), lossy: table.spans.length > 0, limitations: table.spans.length > 0 ? ['Merged cells are represented as one Markdown value; Markdown has no native span semantics.'] : [] };
}

export function exportFormulaLatex(formula: string): StructuredExportResult {
  return { format: 'latex', text: toLatex(formula), lossy: false, limitations: [] };
}

export function extractFormulaExports(text: string): FormulaExport[] {
  return segmentText(text).flatMap((segment: Segment) => segment.kind === 'text' || segment.latex === undefined ? [] : [{ source: segment.value, latex: segment.latex, kind: segment.kind }]);
}

export function exportFormulaSegments(text: string): StructuredExportResult {
  const formulas = extractFormulaExports(text);
  return {
    format: 'latex',
    text: formulas.map(formula => formula.kind === 'display-math' ? `$$${formula.latex}$$` : `$${formula.latex}$`).join('\n'),
    lossy: false,
    limitations: [],
  };
}
