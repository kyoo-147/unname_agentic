/**
 * One searchable command registry shared by the browser reader and every host
 * that reuses it.
 *
 * A command is a descriptor, not a listener: `run` is attached by whichever
 * side owns the behaviour, so a menu, a palette and a key handler can all read
 * the same registration. The registry never invents an action; it only makes
 * the existing ones findable and bindable by name.
 *
 * Chords are written as `[modifiers+]key` and read case-insensitively:
 * `Ctrl+Shift+P` and `ctrl+shift+p` are the same chord, and modifier order
 * never matters. `ctrl` and `meta` stay distinct so a host that wants both
 * (Ctrl on Windows/Linux, Command on macOS) can bind both. A chord needs a
 * non-modifier key; `ctrl+` normalises to nothing and is never bound.
 */

import { t, type TranslationKey } from '../i18n';
import { check, type CapabilityAction, type CapabilityMode } from './capabilities';

/** Group ids a palette renders in this order; headings are the UI's own concern. */
export type CommandGroup = 'document' | 'navigate' | 'view' | 'translate' | 'help';

/** Canonical palette order. Groups with no commands are omitted from `groups()`. */
export const COMMAND_GROUPS: readonly CommandGroup[] = ['document', 'navigate', 'view', 'translate', 'help'];

/** Results a search returns when the caller sets no limit. */
export const DEFAULT_SEARCH_LIMIT = 20;

export interface Command {
  /** Stable unique id, for example `reader.nextPage`. */
  readonly id: string;
  /** Dictionary key for the label the reader and the desktop shell both show. */
  readonly titleKey: TranslationKey;
  readonly group: CommandGroup;
  /** Chords that run this command, primary binding first. */
  readonly keys?: readonly string[];
  /** `false` marks the command unavailable; omitted means enabled. Disabled commands stay listable and resolvable. */
  readonly enabled?: boolean;
  /** Optional capability action required before this command may execute. */
  readonly requires?: CapabilityAction;
  /** Stable explanation shown when a host disables the command. */
  readonly disabledReason?: string;
  /** Behaviour attached by the host. A descriptor without `run` is still searchable and bindable. */
  readonly run?: () => void;
}

export interface CommandSearchOptions {
  /** Maximum results; defaults to {@link DEFAULT_SEARCH_LIMIT}. Values below 1 return nothing. */
  readonly limit?: number;
}

export interface CommandExecutionContext {
  readonly capabilityMode?: CapabilityMode;
}

export interface CommandAvailability {
  readonly enabled: boolean;
  readonly reason?: string;
}

export interface CommandExecution {
  readonly commandId: string;
  readonly executed: boolean;
  readonly reason?: string;
  readonly audit: 'executed' | 'blocked' | 'missing';
}

export interface CommandGroupEntry {
  readonly group: CommandGroup;
  readonly commands: readonly Command[];
}

export interface CommandRegistryOptions {
  /** Text a palette shows and searches. Defaults to `t(command.titleKey)` for the current locale. */
  readonly label?: (command: Command) => string;
}

const MODIFIERS = ['ctrl', 'alt', 'shift', 'meta'] as const;
const MODIFIER_KEYS = new Set<string>(MODIFIERS);
const WORD_CHARACTER = /[\p{L}\p{N}]/u;
const COMBINING_MARKS = /[\u0300-\u036f]/g;
const PREFIX_SCORE = 3;
const WORD_SCORE = 2;
const SUBSEQUENCE_SCORE = 1;

/**
 * Normalises a chord to `ctrl+alt+shift+meta+key` (modifiers present only).
 * Returns an empty string for a chord without a real key, so it never binds.
 */
export function normalizeChord(chord: string): string {
  const parts = chord.split('+').map(part => part.trim().toLowerCase()).filter(part => part.length > 0);
  const key = parts.find(part => !MODIFIER_KEYS.has(part));
  if (key === undefined) return '';
  return [...MODIFIERS.filter(modifier => parts.includes(modifier)), key].join('+');
}

/** Case- and accent-insensitive form used for labels, ids and queries. */
function fold(value: string): string {
  return value
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .replace(/\u0111/g, 'd')
    .toLowerCase();
}

function prepareQuery(query: string): string {
  return fold(query.replace(/\s+/g, ' ').trim());
}

function startsAtWord(haystack: string, needle: string): boolean {
  for (let index = haystack.indexOf(needle); index >= 0; index = haystack.indexOf(needle, index + 1)) {
    const previous = haystack[index - 1];
    if (previous === undefined || !WORD_CHARACTER.test(previous)) return true;
  }
  return false;
}

function isSubsequence(needle: string, haystack: string): boolean {
  const target = haystack.replace(/\s+/g, '');
  let cursor = 0;
  for (const character of target) {
    if (character !== needle[cursor]) continue;
    cursor += 1;
    if (cursor === needle.length) return true;
  }
  return false;
}

function scoreFor(query: string, candidates: readonly string[]): number {
  if (candidates.some(candidate => candidate.startsWith(query))) return PREFIX_SCORE;
  if (candidates.some(candidate => startsAtWord(candidate, query))) return WORD_SCORE;
  if (candidates.some(candidate => isSubsequence(query, candidate))) return SUBSEQUENCE_SCORE;
  return 0;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function flatten(entries: readonly CommandGroupEntry[]): Command[] {
  return entries.flatMap(entry => [...entry.commands]);
}

export class CommandRegistry {
  private readonly commands = new Map<string, Command>();
  private readonly chords = new Map<string, string>();
  private readonly labelOf: (command: Command) => string;

  constructor(options: CommandRegistryOptions = {}) {
    this.labelOf = options.label ?? (command => t(command.titleKey));
  }

  /**
   * Registers one command. An empty or already taken id is refused and changes
   * nothing, including the command's chords. A chord already bound elsewhere
   * keeps its first command, so registration order is the tie-break.
   */
  register(command: Command): boolean {
    if (!command.id || this.commands.has(command.id)) return false;
    this.commands.set(command.id, command);
    for (const chord of command.keys ?? []) {
      const normalized = normalizeChord(chord);
      if (normalized && !this.chords.has(normalized)) this.chords.set(normalized, command.id);
    }
    return true;
  }

  /** Every command in registration order, disabled ones included. */
  all(): Command[] {
    return [...this.commands.values()];
  }

  find(id: string): Command | undefined {
    return this.commands.get(id);
  }

  availability(id: string, context: CommandExecutionContext = {}): CommandAvailability {
    const command = this.find(id);
    return command ? availabilityFor(command, context) : { enabled: false, reason: 'Unknown command.' };
  }

  execute(id: string, context: CommandExecutionContext = {}): CommandExecution {
    const command = this.find(id);
    if (!command) return { commandId: id, executed: false, reason: 'Unknown command.', audit: 'missing' };
    const availability = availabilityFor(command, context);
    if (!availability.enabled) return { commandId: id, executed: false, reason: availability.reason, audit: 'blocked' };
    try {
      command.run?.();
      return { commandId: id, executed: true, audit: 'executed' };
    } catch (error) {
      return { commandId: id, executed: false, reason: error instanceof Error ? error.message : String(error), audit: 'blocked' };
    }
  }

  /**
   * Fuzzy subsequence search over the label and the id, ranked highest first:
   *
   * 1. prefix — the label or the id starts with the query;
   * 2. word start — a word inside the label or id starts with the query;
   * 3. subsequence — the query's characters appear in order (spaces ignored).
   *
   * Accents and case are ignored, so "mo" finds "Mở PDF" just as the reader's
   * own search does. Ties go to the shorter label, then alphabetically, so the
   * order never depends on registration. Disabled commands are returned but
   * marked; the palette decides how to present them. An empty query lists every
   * command in palette order rather than registration order.
   */
  search(query: string, options: CommandSearchOptions = {}): Command[] {
    const limit = Math.max(0, Math.floor(options.limit ?? DEFAULT_SEARCH_LIMIT));
    if (limit === 0) return [];
    const prepared = prepareQuery(query);
    if (!prepared) return flatten(this.groups()).slice(0, limit);

    const matches: { command: Command; score: number; label: string }[] = [];
    for (const command of this.commands.values()) {
      const label = fold(this.labelOf(command));
      const score = scoreFor(prepared, [label, fold(command.id)]);
      if (score > 0) matches.push({ command, score, label });
    }
    matches.sort((left, right) =>
      right.score - left.score ||
      left.label.length - right.label.length ||
      compareText(left.label, right.label) ||
      compareText(left.command.id, right.command.id));
    return matches.slice(0, limit).map(match => match.command);
  }

  /** Resolves a chord to its command, ignoring case, padding and modifier order. */
  resolveChord(chord: string): Command | undefined {
    const id = this.chords.get(normalizeChord(chord));
    return id === undefined ? undefined : this.commands.get(id);
  }

  /**
   * Commands grouped for a palette: groups in canonical order, labels
   * alphabetically inside each group, empty groups omitted. Disabled commands
   * stay in their group and keep `enabled: false`.
   */
  groups(): CommandGroupEntry[] {
    const buckets = new Map<CommandGroup, Command[]>();
    for (const group of COMMAND_GROUPS) buckets.set(group, []);
    for (const command of this.commands.values()) buckets.get(command.group)?.push(command);

    const entries: CommandGroupEntry[] = [];
    for (const group of COMMAND_GROUPS) {
      const commands = buckets.get(group) ?? [];
      if (!commands.length) continue;
      commands.sort((left, right) =>
        compareText(fold(this.labelOf(left)), fold(this.labelOf(right))) || compareText(left.id, right.id));
      entries.push({ group, commands });
    }
    return entries;
  }
}

export function availabilityFor(command: Command, context: CommandExecutionContext = {}): CommandAvailability {
  if (command.enabled === false) return { enabled: false, reason: command.disabledReason ?? 'Command is unavailable.' };
  if (!command.requires) return { enabled: true };
  if (!context.capabilityMode) return { enabled: false, reason: `Capability mode is required for ${command.id}.` };
  const decision = check(context.capabilityMode, command.requires);
  return decision.allowed ? { enabled: true } : { enabled: false, reason: decision.reason };
}

/** Reader actions that already exist, with the chords the reader really listens for. */
const READER_COMMANDS: readonly Command[] = [
  { id: 'reader.open', titleKey: 'openPdf', group: 'document', keys: ['Ctrl+O'] },
  { id: 'reader.exportPdf', titleKey: 'exportPdf', group: 'document', requires: 'exportFile' },
  { id: 'reader.settings', titleKey: 'settingsNav', group: 'document', requires: 'writeSettings' },
  { id: 'reader.previousPage', titleKey: 'previousPage', group: 'navigate', keys: ['K', 'ArrowUp', 'PageUp'] },
  { id: 'reader.nextPage', titleKey: 'nextPage', group: 'navigate', keys: ['J', 'ArrowDown', 'PageDown'] },
  { id: 'reader.firstPage', titleKey: 'firstPage', group: 'navigate', keys: ['Home'] },
  { id: 'reader.lastPage', titleKey: 'lastPage', group: 'navigate', keys: ['End'] },
  { id: 'reader.goToPage', titleKey: 'goToPage', group: 'navigate' },
  { id: 'reader.find', titleKey: 'searchToggle', group: 'navigate', keys: ['Ctrl+F', '/'] },
  { id: 'reader.zoomIn', titleKey: 'zoomIn', group: 'view', keys: ['Ctrl+=', '='] },
  { id: 'reader.zoomOut', titleKey: 'zoomOut', group: 'view', keys: ['Ctrl+-', '-', '_'] },
  { id: 'reader.zoomReset', titleKey: 'zoomReset', group: 'view' },
  { id: 'reader.toggleTranslation', titleKey: 'toggleTranslation', group: 'translate' },
  { id: 'reader.shortcuts', titleKey: 'shortcuts', group: 'help' },
];

/** A fresh registry with every reader action registered, ready for a palette. */
export function readerCommands(): CommandRegistry {
  const registry = new CommandRegistry();
  for (const command of READER_COMMANDS) registry.register(command);
  return registry;
}

export interface PaletteItem {
  readonly command: Command;
  readonly availability: CommandAvailability;
}

export interface CommandPaletteSnapshot {
  readonly open: boolean;
  readonly query: string;
  readonly selectedIndex: number;
  readonly items: readonly PaletteItem[];
  readonly empty: boolean;
}

export interface PaletteKeyEvent {
  readonly key: string;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly shiftKey?: boolean;
}

/**
 * Pure palette state for native or web hosts. It owns keyboard selection and
 * execution, but never creates DOM or performs an action without capability proof.
 */
export class CommandPaletteModel {
  private isOpen = false;
  private queryText = '';
  private selected = 0;
  private context: CommandExecutionContext;

  constructor(private readonly registry: CommandRegistry, context: CommandExecutionContext = {}) {
    this.context = context;
  }

  open(query = ''): CommandPaletteSnapshot {
    this.isOpen = true;
    this.queryText = query;
    this.selected = 0;
    return this.snapshot();
  }

  close(): CommandPaletteSnapshot {
    this.isOpen = false;
    return this.snapshot();
  }

  setContext(context: CommandExecutionContext): CommandPaletteSnapshot {
    this.context = context;
    this.selected = 0;
    return this.snapshot();
  }

  setQuery(query: string): CommandPaletteSnapshot {
    this.queryText = query;
    this.selected = 0;
    return this.snapshot();
  }

  move(delta: number): CommandPaletteSnapshot {
    const count = this.items().length;
    if (count === 0) return this.snapshot();
    const step = Number.isFinite(delta) ? Math.trunc(delta) : 0;
    this.selected = (this.selected + step + count) % count;
    return this.snapshot();
  }

  executeSelected(): CommandExecution {
    const item = this.items()[this.selected];
    if (!item) return { commandId: '', executed: false, reason: 'No command is selected.', audit: 'missing' };
    const result = this.registry.execute(item.command.id, this.context);
    if (result.executed) this.isOpen = false;
    return result;
  }

  handleKey(event: PaletteKeyEvent): CommandExecution | CommandPaletteSnapshot {
    const key = event.key;
    if ((event.ctrlKey === true || event.metaKey === true) && key.toLowerCase() === 'k') return this.open(this.queryText);
    if (key === 'Escape') return this.close();
    if (key === 'ArrowDown') return this.move(1);
    if (key === 'ArrowUp') return this.move(-1);
    if (key === 'Home') { this.selected = 0; return this.snapshot(); }
    if (key === 'End') { this.selected = Math.max(0, this.items().length - 1); return this.snapshot(); }
    if (key === 'Enter') return this.executeSelected();
    if (key.length === 1 && !event.ctrlKey && !event.metaKey && !event.shiftKey) return this.snapshot();
    return this.snapshot();
  }

  snapshot(): CommandPaletteSnapshot {
    const items = this.items();
    const selectedIndex = items.length === 0 ? 0 : Math.min(this.selected, items.length - 1);
    this.selected = selectedIndex;
    return { open: this.isOpen, query: this.queryText, selectedIndex, items, empty: items.length === 0 };
  }

  private items(): PaletteItem[] {
    const commands = this.registry.search(this.queryText);
    return commands.map(command => ({ command, availability: availabilityFor(command, this.context) }));
  }
}
