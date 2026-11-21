import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildDocument } from '../src/core/ir';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const SCRIPT = './scripts/document-workflow.ts';

function fixtureDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'mirror-workflow-cli-'));
}

function run(args: readonly string[]) {
  return spawnSync(process.execPath, ['--experimental-strip-types', '--import', './scripts/ts-extension-loader.mjs', SCRIPT, ...args], { encoding: 'utf8', cwd: ROOT });
}

describe('document-workflow CLI', () => {
  it('runs deterministic local extraction and writes reviewable JSON', () => {
    const dir = fixtureDir();
    try {
      const ir = path.join(dir, 'invoice.json');
      const schema = path.join(dir, 'schema.json');
      const out = path.join(dir, 'result.json');
      writeFileSync(ir, JSON.stringify(buildDocument({
        documentId: 'cli-doc',
        sourceSha256: 'c'.repeat(64),
        pages: [{ index: 1, width: 612, height: 792, rotation: 0 }],
        blocks: [{ page: 1, text: 'Invoice: INV-7', rect: { x: 10, y: 20, width: 100, height: 12 }, confidence: 1, origin: 'pdf-text' }],
      })));
      writeFileSync(schema, JSON.stringify({ fields: [{ id: 'invoice', label: 'Invoice', type: 'identifier', required: true }] }));

      const result = run(['extract', '--ir', ir, '--schema', schema, '--out', out]);
      expect(result.status).toBe(0);
      const output = JSON.parse(readFileSync(out, 'utf8')) as { fields: Array<{ value: string; bbox: { x: number }; validator: { valid: boolean } }> };
      expect(output.fields[0]).toMatchObject({ value: 'INV-7', bbox: { x: 10 }, validator: { valid: true } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('supports a dry-run that validates inputs without writing output', () => {
    const dir = fixtureDir();
    try {
      const ir = path.join(dir, 'input.json');
      const schema = path.join(dir, 'schema.json');
      const out = path.join(dir, 'result.json');
      writeFileSync(ir, JSON.stringify(buildDocument({
        documentId: 'dry-doc', sourceSha256: 'd'.repeat(64), pages: [], blocks: [],
      })));
      writeFileSync(schema, JSON.stringify([{ id: 'invoice', label: 'Invoice', type: 'text', required: false }]));
      const result = run(['extract', '--ir', ir, '--schema', schema, '--out', out, '--dry-run']);
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ dryRun: true, fields: ['invoice'], output: out });
      expect(existsSync(out)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
