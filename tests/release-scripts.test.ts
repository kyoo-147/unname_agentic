import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const packageScript = readFileSync(new URL('../scripts/package-native.ps1', import.meta.url), 'utf8');
const verifyScript = readFileSync(new URL('../scripts/verify-release.ps1', import.meta.url), 'utf8');
const releaseCheck = readFileSync(new URL('../scripts/release-check.mjs', import.meta.url), 'utf8');
const checklist = readFileSync(new URL('../docs/release-checklist.md', import.meta.url), 'utf8');

describe('native release evidence scripts', () => {
  it('packages the real native executable, runtime, host, assets and provenance', () => {
    expect(packageScript).toContain("'pdf_workspace.exe'");
    expect(packageScript).toContain("'pdfium.dll'");
    expect(packageScript).toContain("'pdf-workspace-host.exe'");
    expect(packageScript).toContain("'native-shell/assets'");
    expect(packageScript).toContain("'native-messaging'");
    expect(packageScript).toContain("'MANIFEST.json'");
    expect(packageScript).toContain("'CHECKSUMS.sha256'");
    expect(packageScript).toContain('refusing a mixed-revision release');
    expect(packageScript).toContain('source = [ordered]@{ commit = $commit');
  });

  it('has a safe package preflight and an idempotent committed-revision path', () => {
    expect(packageScript).toContain('[switch]$DryRun');
    expect(packageScript).toContain('[switch]$AllowDirty');
    expect(packageScript).toContain('IDEMPOTENT=existing package is for commit');
    expect(packageScript).toContain('Build artifact manifest, not a fidelity or translation-quality certificate.');
  });

  it('verifies package contents and checksums without claiming a native runtime pass', () => {
    expect(verifyScript).toContain('[switch]$RequireNativePackage');
    expect(verifyScript).toContain("Get-FileHash -LiteralPath $file -Algorithm SHA256");
    expect(verifyScript).toContain('Archive entry is missing');
    expect(verifyScript).toContain('pdf-workspace-host.exe');
    expect(verifyScript).toContain('NATIVE_PACKAGE_REQUIRED=');
  });

  it('keeps native, license and CI evidence fail-closed and distinguishable', () => {
    expect(releaseCheck).toContain('--require-native');
    expect(releaseCheck).toContain('--require-ci');
    expect(releaseCheck).toContain('RELEASE_NATIVE_STATUS');
    expect(releaseCheck).toContain('RELEASE_CI_STATUS');
    expect(releaseCheck).toContain("native run is blocked; no native pass is claimed");
    expect(releaseCheck).toContain('releaseStatus');
    expect(releaseCheck).toContain('requiredEvidenceFailures');
    expect(checklist).toContain('RELEASE_CI_STATUS=blocked');
    expect(checklist).toContain('blocked or unknown native/CI record is never printed as a pass');
  });
});
