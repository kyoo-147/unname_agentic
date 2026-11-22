import { describe, expect, it } from 'vitest';
import {
  AuditError,
  AuditLog,
  findSecret,
  redactSecrets,
  restoreAuditLog,
  toMarkdown,
  verifyAuditChain,
  type AuditActor,
  type AuditChainEntry,
  type AuditDetail,
  type AuditEvent,
  type AuditEventInput,
  type AuditEventKind,
} from '../viewer/src/core/audit';

const AT = '2026-11-20T10:00:00.000Z';

/** A log with a fixed clock, so two runs of the same test write the same bytes. */
function auditLog(now: () => string = () => AT): AuditLog {
  return new AuditLog({ now });
}

function append(
  log: AuditLog,
  kind: AuditEventKind,
  details?: Record<string, AuditDetail>,
  documentId = 'doc-a',
): AuditEvent {
  return log.append({ kind, documentId, actor: 'user', at: AT, details });
}

function failureOf(work: () => unknown): unknown {
  try {
    work();
  } catch (error) {
    return error;
  }
  throw new Error('the call was expected to throw');
}

function messageOf(failure: unknown): string {
  return failure instanceof Error ? failure.message : '';
}

describe('audit log', () => {
  it('appends an event and reads back an isolated copy', () => {
    const log = auditLog();
    const event = append(log, 'import', { format: 'pdf', pages: 12 });

    expect(event).toEqual({
      kind: 'import',
      documentId: 'doc-a',
      at: AT,
      actor: 'user',
      details: { format: 'pdf', pages: 12 },
    });
    expect(log.size).toBe(1);
    expect(log.entries('doc-a')).toEqual([event]);

    // Both the appended event and a read are copies: mutating one changes neither the log
    // nor the other read.
    (event.details as Record<string, unknown>).pages = 99;
    const first = log.entries('doc-a')[0]!;
    (first.details as Record<string, unknown>).format = 'docx';
    expect(log.entries('doc-a')[0]!.details).toEqual({ format: 'pdf', pages: 12 });
    expect(log.entries('doc-a')).toHaveLength(1);
  });

  it('copies a list detail rather than sharing it', () => {
    const log = auditLog();
    append(log, 'extract', { warnings: ['empty page', 'rotated text'] });

    const listed = log.entries('doc-a')[0]!.details.warnings as string[];
    listed.push('injected');
    expect(log.entries('doc-a')[0]!.details.warnings).toEqual(['empty page', 'rotated text']);
  });

  it('refuses an unknown kind', () => {
    const log = auditLog();
    const failure = failureOf(() =>
      log.append({ kind: 'summarize' as unknown as AuditEventKind, documentId: 'doc-a', at: AT }),
    );

    expect(failure).toBeInstanceOf(AuditError);
    expect(failure).toMatchObject({ code: 'unknown-kind', field: 'kind' });
    expect(messageOf(failure)).toContain('summarize');
    expect(log.size).toBe(0);
  });

  it('refuses a missing document id', () => {
    const log = auditLog();
    const blank = failureOf(() => log.append({ kind: 'import', documentId: '   ', at: AT }));
    expect(blank).toMatchObject({ code: 'missing-document-id', field: 'documentId' });

    const notText = failureOf(() =>
      log.append({ kind: 'import', documentId: 42 as unknown as string, at: AT }),
    );
    expect(notText).toMatchObject({ code: 'invalid-document-id', field: 'documentId' });
    expect(log.size).toBe(0);
  });

  it('refuses a secret-looking detail and names the field without echoing it', () => {
    const log = auditLog();
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['note', 'exported for alice@example.test'],
      ['phone', 'call +84 90 123 4567'],
      ['apiKey', 'sk-live-0123456789abcdef0123'],
      ['passphrase', 'password= hunter2!'],
    ];

    for (const [field, value] of cases) {
      const failure = failureOf(() => append(log, 'config', { [field]: value }));
      expect(failure).toBeInstanceOf(AuditError);
      expect(failure).toMatchObject({ code: 'secret-in-detail', field: `details.${field}` });
      expect(messageOf(failure)).toContain(`details.${field}`);
      expect(messageOf(failure)).not.toContain(value);
    }

    expect(log.size).toBe(0);
    expect(log.persist()).not.toContain('alice@example.test');
  });

  it('names the list index of a secret-looking detail', () => {
    const log = auditLog();
    const failure = failureOf(() => append(log, 'review', { notes: ['fine', 'mail bob@example.test'] }));

    expect(failure).toMatchObject({ code: 'secret-in-detail', field: 'details.notes[1]' });
    expect(messageOf(failure)).not.toContain('bob@example.test');
  });

  it('refuses details that are not flat, bounded facts', () => {
    const log = auditLog();

    expect(failureOf(() => append(log, 'import', { nested: { page: 3 } as unknown as AuditDetail })))
      .toMatchObject({ code: 'invalid-details', field: 'details.nested' });
    expect(failureOf(() => append(log, 'import', { text: 'x'.repeat(600) })))
      .toMatchObject({ code: 'invalid-details', field: 'details.text' });
    expect(failureOf(() => append(log, 'import', { pages: Number.NaN })))
      .toMatchObject({ code: 'invalid-details', field: 'details.pages' });
    expect(failureOf(() => append(log, 'import', [] as unknown as Record<string, AuditDetail>)))
      .toMatchObject({ code: 'invalid-details', field: 'details' });

    // A detail field name is scanned too: a field named after an address is the same leak.
    expect(failureOf(() => append(log, 'import', { 'alice@example.test': 1 })))
      .toMatchObject({ code: 'secret-in-detail', field: 'details' });
    expect(log.size).toBe(0);
  });

  it('defaults the actor and stamps the event from the clock', () => {
    const log = auditLog(() => AT);
    const event = log.append({ kind: 'extract', documentId: ' doc-a ' });

    expect(event).toEqual({ kind: 'extract', documentId: 'doc-a', at: AT, actor: 'user', details: {} });
    expect(log.entries('doc-a')).toEqual([event]);
  });

  it('refuses an unknown actor', () => {
    const log = auditLog();
    const failure = failureOf(() =>
      log.append({ kind: 'import', documentId: 'doc-a', at: AT, actor: 'robot' as unknown as AuditActor }),
    );

    expect(failure).toMatchObject({ code: 'unknown-actor', field: 'actor' });
    expect(log.size).toBe(0);
  });

  it('refuses a timestamp without a zone', () => {
    const log = auditLog();
    const failure = failureOf(() =>
      log.append({ kind: 'import', documentId: 'doc-a', at: '2026-11-20 10:00:00' }),
    );

    expect(failure).toMatchObject({ code: 'invalid-timestamp', field: 'at' });
    expect(log.size).toBe(0);
  });

  it('links every chain entry to the one before it', () => {
    const log = auditLog();
    const first = append(log, 'import', { format: 'pdf' });
    append(log, 'extract', { blocks: 88 });
    append(log, 'export', { format: 'docx' });

    const chain = log.chain();
    expect(chain).toHaveLength(3);
    expect(chain[0]!.entry).toEqual(first);
    expect(chain[0]!.prevHash).toBe('');
    expect(chain[0]!.hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(chain[1]!.prevHash).toBe(chain[0]!.hash);
    expect(chain[2]!.prevHash).toBe(chain[1]!.hash);
    expect(new Set(chain.map(item => item.hash)).size).toBe(3);
  });

  it('hashes the same facts the same way whatever order their keys were written in', () => {
    const left = auditLog();
    append(left, 'import', { pages: 12, format: 'pdf' });
    const right = auditLog();
    append(right, 'import', { format: 'pdf', pages: 12 });

    expect(left.chain()[0]!.hash).toBe(right.chain()[0]!.hash);

    const later = auditLog();
    append(later, 'import', { format: 'pdf', pages: 13 });
    expect(later.chain()[0]!.hash).not.toBe(left.chain()[0]!.hash);
  });

  it('pins the chain digest to the SHA-256 of its canonical payload', () => {
    const log = auditLog();
    append(log, 'import');

    // Independently computed with Node's OpenSSL SHA-256 over the UTF-8 bytes of
    // `mirror.audit.v1\n\n` followed by
    // `{"kind":"import","documentId":"doc-a","at":"2026-11-20T10:00:00.000Z","actor":"user","details":[]}`.
    // The pin is what a change to the canonical form or to the digest has to break.
    expect(log.chain()[0]!.hash).toBe('6d44238072d7191967d29468e5fa52dae87fcda29066a48b3696d801af1a678f');
  });

  it('reports the first index whose entry no longer follows the chain', () => {
    const log = auditLog();
    append(log, 'import', { pages: 1 });
    append(log, 'translate', { pages: 2 });
    append(log, 'export', { pages: 3 });
    const chain = log.chain();

    const editedEntry: AuditChainEntry[] = chain.map((item, index) =>
      index === 1 ? { ...item, entry: { ...item.entry, details: { ...item.entry.details, pages: 999 } } } : item,
    );
    expect(verifyAuditChain(editedEntry)).toBe(1);

    const editedLink: AuditChainEntry[] = chain.map((item, index) =>
      index === 2 ? { ...item, prevHash: '' } : item,
    );
    expect(verifyAuditChain(editedLink)).toBe(2);

    const editedHash: AuditChainEntry[] = chain.map((item, index) =>
      index === 0 ? { ...item, hash: 'f'.repeat(64) } : item,
    );
    expect(verifyAuditChain(editedHash)).toBe(0);

    // An edited entry leaves every later hash stale too, and the first break is the edit.
    (chain[1]!.entry.details as Record<string, unknown>).pages = 42;
    expect(verifyAuditChain(chain)).toBe(1);
  });

  it('verifies a clean chain and an empty one', () => {
    const log = auditLog();
    append(log, 'import');
    append(log, 'review');

    expect(log.verifyChain()).toBeNull();
    expect(verifyAuditChain(log.chain())).toBeNull();
    expect(verifyAuditChain([])).toBeNull();
  });

  it('writes a markdown report that carries no raw secrets', () => {
    const log = auditLog();
    append(log, 'import', { format: 'pdf', pages: 12 });
    append(log, 'translate', { model: 'local', pages: 12 });
    const refused = failureOf(() =>
      append(log, 'config', { note: 'api key sk-live-0123456789abcdef0123' }),
    );
    expect(refused).toMatchObject({ code: 'secret-in-detail' });

    const markdown = toMarkdown(log);
    expect(markdown).toContain('# Document audit log');
    expect(markdown).toContain('2 events across 1 document');
    expect(markdown).toContain('Chain head: `');
    expect(markdown).toContain('**import** — user');
    expect(markdown).toContain('  - format: pdf');
    expect(markdown).toContain('## doc-a');
    expect(markdown).not.toContain('sk-live');
    expect(markdown).not.toContain('alice@example.test');

    // The report does not trust its input either: a value that still looks like a secret
    // is masked, because a report is the one artifact a reader copies out of the app.
    const injected: AuditEvent[] = [
      {
        kind: 'config',
        documentId: 'alice@example.test',
        at: AT,
        actor: 'user',
        details: { note: 'mail alice@example.test or call +84 90 123 4567' },
      },
    ];
    const masked = toMarkdown(injected);
    expect(masked).toContain('[redacted]');
    expect(masked).not.toContain('alice@example.test');
    expect(masked).not.toContain('+84 90 123 4567');
    expect(toMarkdown(log.entries())).toBe(markdown);
  });

  it('restores a clean persisted log and keeps appending to it', () => {
    const log = auditLog();
    append(log, 'import', { format: 'pdf' });
    append(log, 'redact', { spans: 4 });

    const restored = restoreAuditLog(log.persist());
    expect(restored.size).toBe(2);
    expect(restored.entries()).toEqual(log.entries());
    expect(restored.chain()).toEqual(log.chain());
    expect(restored.verifyChain()).toBeNull();
    expect(AuditLog.restore(log.persist()).chain()).toEqual(log.chain());

    append(restored, 'export', { format: 'pdf' });
    expect(restored.size).toBe(3);
    expect(restored.chain()[2]!.prevHash).toBe(log.chain()[1]!.hash);
    expect(restored.verifyChain()).toBeNull();
  });

  it('refuses an unknown schema version and unreadable JSON', () => {
    const log = auditLog();
    append(log, 'import');

    const document = JSON.parse(log.persist()) as { schemaVersion: unknown; chain: unknown[] };
    document.schemaVersion = 2;
    const newer = failureOf(() => restoreAuditLog(JSON.stringify(document)));
    expect(newer).toMatchObject({ code: 'unsupported-schema-version', field: 'schemaVersion' });
    expect(messageOf(newer)).toContain('2');

    delete document.schemaVersion;
    expect(failureOf(() => restoreAuditLog(JSON.stringify(document)))).toMatchObject({
      code: 'unsupported-schema-version',
    });

    expect(failureOf(() => restoreAuditLog('{ not json'))).toMatchObject({ code: 'malformed-json' });
    expect(failureOf(() => restoreAuditLog('[]'))).toMatchObject({ code: 'malformed-log' });
  });

  it('refuses a persisted log whose chain was tampered with', () => {
    const log = auditLog();
    append(log, 'import', { pages: 1 });
    append(log, 'translate', { pages: 2 });

    const document = JSON.parse(log.persist()) as {
      chain: Array<{ entry: { details: Record<string, unknown> } }>;
    };
    document.chain[1]!.entry.details.pages = 999;
    const failure = failureOf(() => restoreAuditLog(JSON.stringify(document)));

    expect(failure).toBeInstanceOf(AuditError);
    expect(failure).toMatchObject({ code: 'broken-chain', index: 1, field: 'chain[1]' });
    expect(messageOf(failure)).toContain('1');
  });

  it('refuses a stored field the chain does not cover', () => {
    const log = auditLog();
    append(log, 'import', { pages: 1 });

    const document = JSON.parse(log.persist()) as {
      extra: unknown;
      chain: Array<{ entry: Record<string, unknown>; extra: unknown }>;
    };

    document.chain[0]!.entry.note = 'added by hand';
    expect(failureOf(() => restoreAuditLog(JSON.stringify(document)))).toMatchObject({
      code: 'malformed-log',
      field: 'chain[0].entry.note',
    });

    delete document.chain[0]!.entry.note;
    document.chain[0]!.extra = true;
    expect(failureOf(() => restoreAuditLog(JSON.stringify(document)))).toMatchObject({
      code: 'malformed-log',
      field: 'chain[0].extra',
    });

    delete document.chain[0]!.extra;
    document.extra = 'top level';
    expect(failureOf(() => restoreAuditLog(JSON.stringify(document)))).toMatchObject({
      code: 'malformed-log',
      field: 'extra',
    });
  });

  it('stores only the documented fields, so a caller cannot smuggle one in', () => {
    const log = auditLog();
    log.append({
      kind: 'import',
      documentId: 'doc-a',
      at: AT,
      apiKey: 'sk-live-0123456789abcdef0123',
    } as unknown as AuditEventInput);

    expect(Object.keys(log.entries()[0]!).sort()).toEqual(['actor', 'at', 'details', 'documentId', 'kind']);
    expect(log.persist()).not.toContain('sk-live');
  });

  it('refuses a secret edited into a persisted log', () => {
    const log = auditLog();
    append(log, 'import', { format: 'pdf' });

    const document = JSON.parse(log.persist()) as {
      chain: Array<{ entry: { details: Record<string, unknown> } }>;
    };
    document.chain[0]!.entry.details.note = 'alice@example.test';
    const failure = failureOf(() => restoreAuditLog(JSON.stringify(document)));

    expect(failure).toMatchObject({
      code: 'secret-in-detail',
      field: 'chain[0].entry.details.note',
    });
    expect(messageOf(failure)).not.toContain('alice@example.test');
  });

  it('keeps one document events in append order', () => {
    const log = auditLog();
    append(log, 'import', { step: 1 }, 'doc-a');
    append(log, 'translate', { step: 2 }, 'doc-b');
    append(log, 'export', { step: 3 }, 'doc-a');
    append(log, 'delete', { step: 4 }, 'doc-b');

    expect(log.entries('doc-a').map(event => event.details.step)).toEqual([1, 3]);
    expect(log.entries('doc-b').map(event => event.details.step)).toEqual([2, 4]);
    expect(log.entries().map(event => event.details.step)).toEqual([1, 2, 3, 4]);
    expect(log.entries('doc-missing')).toEqual([]);
    expect(log.chain()).toHaveLength(4);
  });

  it('handles an empty log', () => {
    const log = auditLog();

    expect(log.size).toBe(0);
    expect(log.entries()).toEqual([]);
    expect(log.entries('doc-a')).toEqual([]);
    expect(log.chain()).toEqual([]);
    expect(log.verifyChain()).toBeNull();

    const restored = restoreAuditLog(log.persist());
    expect(restored.size).toBe(0);
    expect(restored.verifyChain()).toBeNull();

    const markdown = toMarkdown(log);
    expect(markdown).toContain('# Document audit log');
    expect(markdown).toContain('No events recorded.');
    expect(markdown).not.toContain('##');
  });

  it('finds and masks the three kinds of secret on its own', () => {
    expect(findSecret('plain words only')).toBeNull();
    expect(findSecret('write to alice@example.test')).toBe('email');
    expect(findSecret('call +84 90 123 4567')).toBe('phone');
    expect(findSecret('token sk-live-0123456789abcdef0123')).toBe('api-key');
    expect(findSecret('a 64-character document hash is not a secret')).toBeNull();

    // A hash is content the log is meant to keep, so it is not treated as a credential.
    const digest = 'a'.repeat(64);
    expect(findSecret(digest)).toBeNull();
    expect(redactSecrets(digest)).toBe(digest);

    expect(redactSecrets('mail alice@example.test now')).toBe('mail [redacted] now');
    expect(redactSecrets('nothing to hide')).toBe('nothing to hide');
  });
});
