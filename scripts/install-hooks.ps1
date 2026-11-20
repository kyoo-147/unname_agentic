# Install the versioned hooks (.githooks) as this clone's hooks path.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
& git -C $root config core.hooksPath .githooks
if ($LASTEXITCODE -ne 0) { throw 'git config core.hooksPath failed' }
Write-Host 'Hooks installed: core.hooksPath = .githooks (pre-push runs the local CI gate).'