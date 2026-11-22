import { describe, expect, it, vi } from 'vitest';
import {
  COMMAND_GROUPS,
  CommandPaletteModel,
  CommandRegistry,
  normalizeChord,
  readerCommands,
  type Command,
  type CommandGroup,
} from '../viewer/src/core/commands';
import { LOCALES, dictionaryFor } from '../viewer/src/i18n';

function command(id: string, group: CommandGroup = 'view', extra: Partial<Command> = {}): Command {
  return { id, titleKey: 'zoomIn', group, ...extra };
}

function registryWithLabels(labels: Record<string, string>): CommandRegistry {
  return new CommandRegistry({ label: candidate => labels[candidate.id] ?? candidate.id });
}

describe('command search', () => {
  it('ranks a prefix match above a word start and both above a subsequence', () => {
    const registry = registryWithLabels({
      'view.subsequence': 'Zero-order optical model',
      'view.word': 'Reset zoom',
      'view.prefix': 'Zoom in',
    });
    registry.register(command('view.subsequence'));
    registry.register(command('view.word'));
    registry.register(command('view.prefix'));

    expect(registry.search('zoom').map(match => match.id)).toEqual(['view.prefix', 'view.word', 'view.subsequence']);
  });

  it('prefers the shorter label when two commands score the same', () => {
    const registry = registryWithLabels({ 'view.long': 'Zoom in', 'view.short': 'Zoom' });
    registry.register(command('view.long'));
    registry.register(command('view.short'));

    expect(registry.search('zoom').map(match => match.id)).toEqual(['view.short', 'view.long']);
  });

  it('matches the id as well as the label', () => {
    const registry = registryWithLabels({ 'reader.jump': 'Go to start' });
    registry.register(command('reader.jump', 'navigate'));

    expect(registry.search('jump').map(match => match.id)).toEqual(['reader.jump']);
  });

  it('ignores accents so an unaccented query still finds the label', () => {
    const registry = registryWithLabels({ 'reader.open': 'Mở PDF' });
    registry.register(command('reader.open', 'document'));

    expect(registry.search('mo').map(match => match.id)).toEqual(['reader.open']);
  });

  it('returns nothing for a query that matches no command', () => {
    const registry = registryWithLabels({ 'view.zoom': 'Zoom in' });
    registry.register(command('view.zoom'));

    expect(registry.search('qwerty')).toEqual([]);
  });

  it('honours the result limit and lists everything in palette order for an empty query', () => {
    const registry = registryWithLabels({ 'view.alpha': 'Page alpha', 'view.beta': 'Page beta', 'view.gamma': 'Page gamma' });
    registry.register(command('view.gamma'));
    registry.register(command('view.alpha'));
    registry.register(command('view.beta'));

    expect(registry.search('page', { limit: 2 })).toHaveLength(2);
    expect(registry.search('page', { limit: 0 })).toEqual([]);
    expect(registry.search('').map(match => match.id)).toEqual(['view.alpha', 'view.beta', 'view.gamma']);
  });
});

describe('registration', () => {
  it('refuses a duplicate id and leaves the first command bound', () => {
    const registry = new CommandRegistry({ label: () => 'Open' });
    const first = command('reader.open', 'document', { keys: ['Ctrl+O'] });
    const second = command('reader.open', 'document', { keys: ['Ctrl+Shift+O'], enabled: false });

    expect(registry.register(first)).toBe(true);
    expect(registry.register(second)).toBe(false);
    expect(registry.all()).toEqual([first]);
    expect(registry.find('reader.open')).toBe(first);
    expect(registry.resolveChord('ctrl+shift+o')).toBeUndefined();
    expect(registry.resolveChord('ctrl+o')).toBe(first);
  });

  it('refuses an empty id', () => {
    const registry = new CommandRegistry({ label: () => '' });
    expect(registry.register(command(''))).toBe(false);
    expect(registry.all()).toEqual([]);
  });

  it('keeps the registered descriptor, including its run hook', () => {
    const registry = new CommandRegistry({ label: candidate => candidate.id });
    const run = vi.fn();
    const descriptor = command('view.actual', 'view', { run });

    registry.register(descriptor);
    expect(registry.find('view.actual')).toBe(descriptor);
    registry.find('view.actual')?.run?.();
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe('chord resolution', () => {
  it('normalises case, padding and modifier order', () => {
    expect(normalizeChord('Ctrl+Shift+P')).toBe('ctrl+shift+p');
    expect(normalizeChord('shift + CTRL + p')).toBe('ctrl+shift+p');
    expect(normalizeChord('  ctrl+SHIFT+p  ')).toBe('ctrl+shift+p');

    const registry = new CommandRegistry({ label: candidate => candidate.id });
    const palette = command('shell.palette', 'help', { keys: ['Ctrl+Shift+P'] });
    registry.register(palette);

    expect(registry.resolveChord('ctrl+shift+p')).toBe(palette);
    expect(registry.resolveChord('CTRL + SHIFT + P')).toBe(palette);
    expect(registry.resolveChord('ctrl+p')).toBeUndefined();
    expect(registry.resolveChord('ctrl+shift+o')).toBeUndefined();
  });

  it('keeps ctrl and meta distinct and never binds a bare modifier', () => {
    expect(normalizeChord('Meta+O')).toBe('meta+o');
    expect(normalizeChord('ctrl+')).toBe('');
    expect(normalizeChord('ctrl+shift')).toBe('');

    const registry = new CommandRegistry({ label: candidate => candidate.id });
    const open = command('reader.open', 'document', { keys: ['Ctrl+O'] });
    registry.register(open);
    expect(registry.resolveChord('ctrl+o')).toBe(open);
    expect(registry.resolveChord('meta+o')).toBeUndefined();
  });

  it('resolves the real reader chords, including unmodified keys and case', () => {
    const registry = readerCommands();

    expect(registry.resolveChord('ctrl+o')?.id).toBe('reader.open');
    expect(registry.resolveChord('CTRL+F')?.id).toBe('reader.find');
    expect(registry.resolveChord('j')?.id).toBe('reader.nextPage');
    expect(registry.resolveChord('J')?.id).toBe('reader.nextPage');
    expect(registry.resolveChord('Home')?.id).toBe('reader.firstPage');
    expect(registry.resolveChord('ctrl+=')?.id).toBe('reader.zoomIn');
    expect(registry.resolveChord('Escape')).toBeUndefined();
  });
});

describe('groups', () => {
  it('orders groups canonically and labels alphabetically inside each group', () => {
    const registry = registryWithLabels({ a: 'Zulu', b: 'Alpha', c: 'Mike', d: 'Solo' });
    registry.register(command('a', 'view'));
    registry.register(command('b', 'view'));
    registry.register(command('c', 'navigate'));
    registry.register(command('d', 'document'));

    const groups = registry.groups();
    expect(groups.map(entry => entry.group)).toEqual(['document', 'navigate', 'view']);
    expect(groups[0]!.commands.map(match => match.id)).toEqual(['d']);
    expect(groups[1]!.commands.map(match => match.id)).toEqual(['c']);
    expect(groups[2]!.commands.map(match => match.id)).toEqual(['b', 'a']);
  });

  it('omits groups with no commands and keeps disabled ones in place', () => {
    const registry = registryWithLabels({ 'view.locked': 'Locked' });
    registry.register(command('view.locked', 'view', { enabled: false }));
    registry.register(command('view.ready', 'view'));

    const groups = registry.groups();
    expect(groups).toHaveLength(1);
    expect(groups[0]!.commands.map(match => match.id)).toEqual(['view.locked', 'view.ready']);
    expect(groups[0]!.commands[0]!.enabled).toBe(false);
    expect(groups[0]!.commands[1]!.enabled).toBeUndefined();
  });
});

describe('disabled commands', () => {
  it('returns disabled commands from search and marks them', () => {
    const registry = registryWithLabels({ 'view.locked': 'Locked' });
    const locked = command('view.locked', 'view', { enabled: false, keys: ['Ctrl+L'] });
    registry.register(locked);
    registry.register(command('view.ready', 'view'));

    const results = registry.search('locked');
    expect(results.map(match => match.id)).toEqual(['view.locked']);
    expect(results[0]!.enabled).toBe(false);
    expect(registry.all()).toHaveLength(2);
    expect(registry.resolveChord('ctrl+l')).toBe(locked);
  });
});

describe('palette state and capability execution', () => {
  it('navigates deterministically, exposes an empty state, and audits blocked execution', () => {
    const registry = new CommandRegistry({ label: candidate => candidate.id });
    const run = vi.fn();
    registry.register(command('reader.export', 'document', { requires: 'exportFile', run }));
    const palette = new CommandPaletteModel(registry, { capabilityMode: 'reader' });
    expect(palette.open('missing').empty).toBe(true);
    palette.setQuery('export');
    const item = palette.snapshot().items[0];
    expect(item?.availability.enabled).toBe(false);
    expect(item?.availability.reason).toContain('reader');
    expect(palette.handleKey({ key: 'Enter' })).toMatchObject({ executed: false, audit: 'blocked' });
    expect(run).not.toHaveBeenCalled();
  });

  it('binds host actions without changing the reader command descriptors', () => {
    const run = vi.fn();
    const registry = readerCommands({ 'reader.zoomReset': run });
    const palette = new CommandPaletteModel(registry, { capabilityMode: 'local' });
    palette.open('reader.zoomReset');
    expect(palette.handleKey({ key: 'Enter' })).toMatchObject({ executed: true });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('executes an allowed command and closes the palette', () => {
    const registry = new CommandRegistry({ label: candidate => candidate.id });
    const run = vi.fn();
    registry.register(command('reader.export', 'document', { requires: 'exportFile', run }));
    const palette = new CommandPaletteModel(registry, { capabilityMode: 'local' });
    palette.open('export');
    expect(palette.handleKey({ key: 'Enter' })).toMatchObject({ executed: true, audit: 'executed' });
    expect(run).toHaveBeenCalledTimes(1);
    expect(palette.snapshot().open).toBe(false);
  });
});

describe('default reader commands', () => {
  const registry = readerCommands();

  it('registers each action once, in a known group', () => {
    const ids = registry.all().map(match => match.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThanOrEqual(11);
    for (const match of registry.all()) {
      expect(match.id.startsWith('reader.')).toBe(true);
      expect(COMMAND_GROUPS).toContain(match.group);
    }
    expect(registry.groups().map(entry => entry.group)).toEqual([...COMMAND_GROUPS]);
  });

  it('gives every command a label that exists in all three dictionaries', () => {
    for (const match of registry.all()) {
      for (const locale of LOCALES) {
        const dictionary = dictionaryFor(locale);
        expect(Object.hasOwn(dictionary, match.titleKey), `${locale}: ${match.titleKey}`).toBe(true);
        expect(dictionary[match.titleKey].trim().length, `${locale}: ${match.titleKey}`).toBeGreaterThan(0);
      }
    }
  });

  it('binds each chord to exactly one command', () => {
    const seen = new Set<string>();
    for (const match of registry.all()) {
      for (const chord of match.keys ?? []) {
        const normalized = normalizeChord(chord);
        expect(normalized.length).toBeGreaterThan(0);
        expect(seen.has(normalized), `${match.id}: ${chord}`).toBe(false);
        seen.add(normalized);
      }
    }
  });
});
