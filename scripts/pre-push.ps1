# Pre-push gate: the same checks the GitHub workflow would run, executed locally.
#
# GitHub Actions cannot start for this account (billing lock), so the gate runs
# here instead: a push that fails these checks is refused. Install once with
# `powershell -NoProfile -File scripts/install-hooks.ps1`.
#
# Native tools write progress to stderr, which PowerShell 5.1 turns into a
# terminating error under 'Stop'; the gate only trusts exit codes, so it keeps
# 'Continue' and decides from $LASTEXITCODE alone.
param([switch]$Quick)
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
$failed = New-Object System.Collections.Generic.List[string]
$summary = ''

function Step([string]$label, [scriptblock]$action) {
  Write-Host "[pre-push] $label"
  & $action 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { $script:failed.Add($label) }
}

try {
  Step 'typecheck' { pnpm typecheck }
  Write-Host '[pre-push] unit tests'
  $out = (& pnpm test 2>&1 | Out-String)
  if ($LASTEXITCODE -ne 0) { $failed.Add('pnpm test') }
  $line = ($out -split "`n" | Where-Object { $_ -match 'Tests\s+\d' } | Select-Object -Last 1)
  if ($line) { $summary = $line.Trim(); Write-Host ("[pre-push] " + $summary) }
  Step 'committed imports' { node scripts/check-committed-imports.mjs }
  if (-not $Quick) { Step 'build' { pnpm build } }
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
