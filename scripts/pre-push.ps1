# Pre-push gate: the same checks the GitHub workflow would run, executed locally.
#
# GitHub Actions cannot start for this account (billing lock), so the gate runs
# here instead: a push that fails these checks is refused. Install once with
# `powershell -NoProfile -File scripts/install-hooks.ps1`.
param([switch]$Quick)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
$failed = New-Object System.Collections.Generic.List[string]
try {
  Write-Host '[pre-push] typecheck'
  & pnpm typecheck *> $null
  if ($LASTEXITCODE -ne 0) { $failed.Add('pnpm typecheck') }

  Write-Host '[pre-push] unit tests'
  $out = & pnpm test 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0) { $failed.Add('pnpm test') }
  ($out -split "`n" | Where-Object { $_ -match 'Tests\s+\d' } | Select-Object -Last 1) | ForEach-Object { Write-Host ("[pre-push] " + $_.Trim()) }

  Write-Host '[pre-push] committed imports'
  & node scripts/check-committed-imports.mjs *> $null
  if ($LASTEXITCODE -ne 0) { $failed.Add('check-committed-imports') }

  if (-not $Quick) {
    Write-Host '[pre-push] build'
    & pnpm build *> $null
    if ($LASTEXITCODE -ne 0) { $failed.Add('pnpm build') }
  }
} finally {
  Pop-Location
}
if ($failed.Count -gt 0) {
  Write-Host ''
  Write-Host ("[pre-push] BLOCKED: " + ($failed -join ', ')) -ForegroundColor Red
  exit 1
}
Write-Host '[pre-push] all gates passed'
exit 0
