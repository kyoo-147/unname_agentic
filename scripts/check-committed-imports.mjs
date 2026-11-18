#!/usr/bin/env node
// Guard against committing a module that is referenced but never added to git.
//
// This happened for real: src/main.ts shipped `await import('./ocr/scan')` while
// src/ocr/scan.ts was still untracked, so `main` built locally and broke for
// everyone else. A local green build cannot catch that: the file exists on disk.
// This script resolves every relative import of every file *at a git revision*
// against the file list of that same revision, so the check is about the commit,
// not the working tree.
//
// Usage:
//   node scripts/check-committed-imports.mjs            # checks HEAD
//   node scripts/check-committed-imports.mjs <rev>      # checks any revision
// Exit codes: 0 clean, 1 unresolved imports, 2 git failure.

import { execFileSync } from 'node:child_process';

const revision = process.argv[2] ?? 'HEAD';
const CANDIDATE_SUFFIXES = ['', '.ts', '.tsx', '.js', '.mjs', '.css', '.json', '/index.ts', '/index.tsx', '/index.js'];

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

let files;
try {
  files = git(['ls-tree', '-r', '--name-only', revision]).split('\n').filter(Boolean);
} catch (error) {
  console.error(`could not list files at ${revision}: ${error.message}`);
  process.exit(2);
}

const known = new Set(files);
const sources = files.filter(path => /\.(ts|tsx|mts|mjs|js|jsx)$/.test(path) && !path.startsWith('dist/') && !path.includes('node_modules/'));

const SPECIFIER = /(?:^|[^.\w])(?:import|export)\s+(?:type\s+)?(?:[^'"()]*?\sfrom\s+)?['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map(line => line.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n');
}

function isRelative(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}

function resolveSpecifier(fromPath, specifier) {
  const base = fromPath.split('/').slice(0, -1).join('/');
  const stack = [];
  for (const part of `${base}/${specifier}`.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') stack.pop();
    else stack.push(part);
  }
  const target = stack.join('/');
  for (const suffix of CANDIDATE_SUFFIXES) {
    const candidate = target + suffix;
    if (known.has(candidate)) return candidate;
  }
  return null;
}

const problems = [];
for (const path of sources) {
  let text;
  try {
    text = git(['show', `${revision}:${path}`]);
  } catch (error) {
    problems.push({ path, specifier: '(unreadable)', detail: error.message });
    continue;
  }
  const clean = stripComments(text);
  for (const match of clean.matchAll(SPECIFIER)) {
    const specifier = match[1] ?? match[2] ?? match[3];
    if (!specifier || !isRelative(specifier)) continue;
    if (!resolveSpecifier(path, specifier)) problems.push({ path, specifier, detail: 'no committed file matches' });
  }
}

if (problems.length) {
  console.error(`committed-imports: ${problems.length} unresolved relative import(s) at ${revision}`);
  for (const problem of problems) console.error(`  ${problem.path} -> ${problem.specifier} (${problem.detail})`);
  process.exit(1);
}

console.log(`committed-imports: ${sources.length} files at ${revision}, every relative import resolves`);
