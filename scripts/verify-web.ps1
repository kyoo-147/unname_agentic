<#
.SYNOPSIS
Run the web verification gate and print one summary.

.PARAMETER E2E
Also run the Chromium end-to-end suite (starts Vite and the test provider).
#>
[CmdletBinding()]
param([switch]$E2E)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
    $results = [System.Collections.Generic.List[object]]::new()
    function Step([string]$Name, [scriptblock]$Body) {
        $started = Get-Date
        try {
            & $Body
            $results.Add([pscustomobject]@{ Step = $Name; Result = 'PASS'; Seconds = [math]::Round(((Get-Date) - $started).TotalSeconds, 1) })
        } catch {
            $results.Add([pscustomobject]@{ Step = $Name; Result = 'FAIL'; Seconds = [math]::Round(((Get-Date) - $started).TotalSeconds, 1) })
            throw
        }
    }
    Step 'unit' { pnpm test; if ($LASTEXITCODE -ne 0) { throw 'unit tests failed' } }
    Step 'typecheck' { pnpm typecheck; if ($LASTEXITCODE -ne 0) { throw 'typecheck failed' } }
    Step 'build' { pnpm build; if ($LASTEXITCODE -ne 0) { throw 'build failed' } }
    if ($E2E) { Step 'e2e' { pnpm test:e2e; if ($LASTEXITCODE -ne 0) { throw 'e2e failed' } } }
    $results | Format-Table -AutoSize | Out-String | Write-Output
    if ($results.Where({ $_.Result -ne 'PASS' }).Count -gt 0) { exit 1 }
} finally {
    Pop-Location
}
