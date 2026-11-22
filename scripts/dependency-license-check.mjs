#!/usr/bin/env node
/**
 * Offline dependency/license evidence check for the release gate.
 *
 * It compares package.json runtime dependencies with the checked-in CycloneDX SBOM and
 * refuses missing, duplicate, unversioned or unlicensed components. It also refuses AGPL
 * text in the SBOM because this repository's release policy requires an explicit legal
 * review before such a dependency can ship. No registry, network or package download is
 * used.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const packagePath = path.join(root, 'package.json');
const sbomPath = path.join(root, 'extension', 'viewer', 'public', 'third-party', 'SBOM.json');

function fail(message) {
  console.log(JSON.stringify({ ok: false, error: message }));
  process.exit(1);
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    fail(`${path.relative(root, file)} is missing or malformed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const pkg = readJson(packagePath);
const sbom = readJson(sbomPath);
const dependencies = Object.keys(pkg.dependencies ?? {}).sort();
const components = Array.isArray(sbom.components) ? sbom.components : [];
const names = components.map(component => component?.name).filter(name => typeof name === 'string');
const duplicateNames = [...new Set(names.filter((name, index) => names.indexOf(name) !== index))].sort();
const missing = dependencies.filter(name => !names.includes(name));
const unlicensed = dependencies.filter(name => {
  const component = components.find(candidate => candidate?.name === name);
  return !Array.isArray(component?.licenses) || component.licenses.length === 0
    || component.licenses.some(entry => typeof entry?.license?.id !== 'string' && typeof entry?.license?.name !== 'string');
});
const unversioned = dependencies.filter(name => {
  const component = components.find(candidate => candidate?.name === name);
  return typeof component?.version !== 'string' || component.version.trim() === '';
});
const agpl = JSON.stringify(sbom).match(/AGPL/iu) !== null;
const malformed = sbom?.bomFormat !== 'CycloneDX'
  || typeof sbom?.specVersion !== 'string'
  || !Array.isArray(sbom?.components)
  || sbom.components.length === 0;
const ok = !malformed && missing.length === 0 && duplicateNames.length === 0
  && unlicensed.length === 0 && unversioned.length === 0 && !agpl;

console.log(JSON.stringify({
  ok,
  sbom: path.relative(root, sbomPath).split(path.sep).join('/'),
  runtimeDependencies: dependencies,
  componentCount: components.length,
  missing,
  duplicateNames,
  unlicensed,
  unversioned,
  agpl,
  malformed,
}, null, 2));
process.exit(ok ? 0 : 1);
