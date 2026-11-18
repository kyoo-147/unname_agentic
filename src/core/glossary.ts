export interface GlossaryEntry {
  source: string;
  target: string;
}

export type GlossaryIssueCode = 'missing-separator' | 'empty-source' | 'empty-target' | 'source-too-long' | 'target-too-long' | 'duplicate' | 'entry-limit';

export interface GlossaryIssue {
  line: number;
  code: GlossaryIssueCode;
  message: string;
}

export interface GlossaryParseResult {
  entries: GlossaryEntry[];
  issues: GlossaryIssue[];
}

export const GLOSSARY_MAX_ENTRIES = 200;
export const GLOSSARY_MAX_SOURCE_CHARS = 64;
export const GLOSSARY_MAX_TARGET_CHARS = 128;

const ISSUE_MESSAGES: Record<GlossaryIssueCode, string> = {
  'missing-separator': 'Use "source = target" on each line.',
  'empty-source': 'The source term is empty.',
  'empty-target': 'The translated term is empty.',
  'source-too-long': `The source term exceeds ${GLOSSARY_MAX_SOURCE_CHARS} characters.`,
  'target-too-long': `The translated term exceeds ${GLOSSARY_MAX_TARGET_CHARS} characters.`,
  duplicate: 'The source term is already defined.',
  'entry-limit': `Only the first ${GLOSSARY_MAX_ENTRIES} terms are kept.`,
};

export function parseGlossary(text: string): GlossaryParseResult {
  const entries: GlossaryEntry[] = [];
  const issues: GlossaryIssue[] = [];
  const seen = new Set<string>();
  const lines = text.split(/\r?\n/);

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!.trim();
    if (!line) continue;
    const issue = (code: GlossaryIssueCode) => issues.push({ line: index + 1, code, message: ISSUE_MESSAGES[code] });
    const separator = line.indexOf('=');
    if (separator < 0) {
      issue('missing-separator');
      continue;
    }
    const source = line.slice(0, separator).trim();
    const target = line.slice(separator + 1).trim();
    if (!source) {
      issue('empty-source');
      continue;
    }
    if (!target) {
      issue('empty-target');
      continue;
    }
    if (source.length > GLOSSARY_MAX_SOURCE_CHARS) {
      issue('source-too-long');
      continue;
    }
    if (target.length > GLOSSARY_MAX_TARGET_CHARS) {
      issue('target-too-long');
      continue;
    }
    const key = source.toLowerCase();
    if (seen.has(key)) {
      issue('duplicate');
      continue;
    }
    if (entries.length >= GLOSSARY_MAX_ENTRIES) {
      issue('entry-limit');
      break;
    }
    seen.add(key);
    entries.push({ source, target });
  }

  return { entries, issues };
}

const clean = (value: string): string => value.replace(/\s+/g, ' ').trim();

export function glossaryToPrompt(entries: readonly GlossaryEntry[]): string {
  return entries
    .map(entry => ({ source: clean(entry.source), target: clean(entry.target) }))
    .filter(entry => entry.source && entry.target)
    .slice(0, GLOSSARY_MAX_ENTRIES)
    .map(entry => `${entry.source} = ${entry.target}`)
    .join('\n');
}

export interface GlossaryMatch {
  source: string;
  target: string;
  index: number;
}

export function findGlossaryTerms(text: string, entries: readonly GlossaryEntry[]): GlossaryMatch[] {
  const haystack = text.toLowerCase();
  const matches: GlossaryMatch[] = [];
  for (const entry of entries) {
    const source = clean(entry.source);
    if (!source) continue;
    const needle = source.toLowerCase();
    let from = 0;
    while (from <= haystack.length - needle.length) {
      const index = haystack.indexOf(needle, from);
      if (index < 0) break;
      matches.push({ source: entry.source, target: entry.target, index });
      from = index + Math.max(1, needle.length);
    }
  }
  return matches.sort((a, b) => a.index - b.index || b.source.length - a.source.length);
}
