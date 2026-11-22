#!/usr/bin/env node
/**
 * Local structured-extraction CLI.
 *
 * It accepts a canonical Document IR JSON file and a schema JSON file. PDF parsing
 * remains owned by the app/native lanes; this command is the deterministic local
 * workflow boundary after import and is safe to run headlessly.
 *
 * Examples:
 *   node --experimental-strip-types --import ./scripts/ts-extension-loader.mjs scripts/document-workflow.ts extract --ir input.json --schema invoice.json
 *   node --experimental-strip-types --import ./scripts/ts-extension-loader.mjs scripts/document-workflow.ts extract --ir input.json --schema invoice.json --out result.json
 *   node --experimental-strip-types --import ./scripts/ts-extension-loader.mjs scripts/document-workflow.ts extract --ir input.json --schema invoice.json --dry-run
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate } from '../extension/viewer/src/core/ir.ts';
import { defineSchema } from '../extension/viewer/src/core/schema.ts';
import { extractReviewableDocument, serializeStructuredExtraction } from '../extension/viewer/src/core/workflow.ts';
import type { DocumentIR } from '../extension/viewer/src/core/ir.ts';

const PROGRAM = 'document-workflow';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI_SCRIPT = './scripts/document-workflow.ts';

interface Options {
  command: 'extract' | 'help';
  ir: string | null;
  schema: string | null;
  out: string | null;
  format: 'json' | 'csv';
  dryRun: boolean;
}

function usage(): string {
  return [
    `${PROGRAM} - local schema-based document extraction`,
    '',
    'Usage:',
    `  ${PROGRAM} extract --ir <document.json> --schema <schema.json> [--out <result.json>] [--dry-run]`,
    '',
    'Options:',
    '  --ir      Canonical Document IR JSON input.',
    '  --schema  Field schema JSON input: an array or {"fields": [...]} .',
    '  --out     Write structured review output. Default: stdout.',
    '  --format  Output format: json (default) or csv.',
    '  --dry-run Validate inputs and print the plan without writing output.',
    '  --help    Print this help.',
    '',
    'Examples:',
    `  node --experimental-strip-types --import ./scripts/ts-extension-loader.mjs ${CLI_SCRIPT} extract --ir invoice.json --schema invoice-schema.json`,
    `  node --experimental-strip-types --import ./scripts/ts-extension-loader.mjs ${CLI_SCRIPT} extract --ir invoice.json --schema invoice-schema.json --out result.json`,
  ].join('\n') + '\n';
}

function parse(argv: readonly string[]): Options {
  const options: Options = { command: 'help', ir: null, schema: null, out: null, format: 'json', dryRun: false };
  if (argv.length === 0 || argv.includes('--help')) return options;
  if (argv[0] !== 'extract') throw new Error(`unknown command "${argv[0]}". Run ${PROGRAM} --help.`);
  options.command = 'extract';
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    if (token === '--format') {
      const value = argv[++index];
      if (value !== 'json' && value !== 'csv') throw new Error('--format must be json or csv.');
      options.format = value;
      continue;
    }
    if (token !== '--ir' && token !== '--schema' && token !== '--out') throw new Error(`unknown flag "${token}". Run ${PROGRAM} --help.`);
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`${token} needs a file path.`);
    if (token === '--ir') options.ir = value;
    if (token === '--schema') options.schema = value;
    if (token === '--out') options.out = value;
  }
  if (!options.ir || !options.schema) throw new Error('extract needs --ir and --schema.');
  return options;
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(path.resolve(file), 'utf8')) as unknown;
}

function main(argv: readonly string[]): number {
  try {
    const options = parse(argv);
    if (options.command === 'help') {
      process.stdout.write(usage());
      return 0;
    }
    const document = readJson(options.ir!) as DocumentIR;
    const problems = validate(document);
    if (problems.length > 0) throw new Error(`invalid Document IR: ${problems.map(problem => problem.code).join(', ')}`);
    const schema = defineSchema(readJson(options.schema!));
    if (options.dryRun) {
      process.stdout.write(JSON.stringify({ dryRun: true, command: 'extract', fields: schema.map(field => field.id), format: options.format, output: options.out ?? 'stdout' }, null, 2) + '\n');
      return 0;
    }
    const output = extractReviewableDocument(document, schema);
    const serialized = serializeStructuredExtraction(output, options.format);
    if (options.out) writeFileSync(path.resolve(options.out), serialized, 'utf8');
    else process.stdout.write(serialized);
    return 0;
  } catch (error) {
    process.stderr.write(`${PROGRAM}: ${error instanceof Error ? error.message : String(error)}\n`);
    process.stderr.write(`Run "${PROGRAM} --help" for usage.\n`);
    return 2;
  }
}

process.exitCode = main(process.argv.slice(2));
