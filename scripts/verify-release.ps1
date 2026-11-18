<#
.SYNOPSIS
Run the release gate and print one per-check table.

.DESCRIPTION
Runs the same phases CI runs (unit, typecheck, build, e2e), then checks the
build output itself:

  * dist/extension carries only bundles this build produced, has a Manifest V3
    manifest.json, and keeps no stale index-<hash>.js from an earlier build.
  * dist/web/index.html references only files that exist in dist/web.

The first failing check stops the gate, prints the table, and exits 1.

.PARAMETER ArtifactsOnly
Check the existing dist output without running unit, typecheck, build or e2e.

.EXAMPLE
pwsh -File scripts/verify-release.ps1

.EXAMPLE
pwsh -File scripts/verify-release.ps1 -ArtifactsOnly
#>
[CmdletBinding()]
param([switch]$ArtifactsOnly)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
    $results = [System.Collections.Generic.List[object]]::new()
    function Step([string]$Name, [scriptblock]$Body) {
        $started = Get-Date
        try {
            & $Body
            $results.Add([pscustomobject]@{ Check = $Name; Result = 'PASS'; Seconds = [math]::Round(((Get-Date) - $started).TotalSeconds, 1); Detail = '' })
        } catch {
            $results.Add([pscustomobject]@{ Check = $Name; Result = 'FAIL'; Seconds = [math]::Round(((Get-Date) - $started).TotalSeconds, 1); Detail = $_.Exception.Message })
            $results | Format-Table -AutoSize -Wrap | Out-String | Write-Output
            throw
        }
    }

    function Assert-ExtensionOutput {
        $output = Join-Path $root 'dist/extension'
        $web = Join-Path $root 'dist/web'
        if (-not (Test-Path -LiteralPath $output)) { throw 'dist/extension is missing; run pnpm build first.' }
        $manifestPath = Join-Path $output 'manifest.json'
        if (-not (Test-Path -LiteralPath $manifestPath)) { throw 'dist/extension/manifest.json is missing.' }
        $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
        if ($manifest.manifest_version -ne 3) { throw "dist/extension/manifest.json is not Chrome MV3 (manifest_version=$($manifest.manifest_version))." }
        $required = @('manifest.json', 'popup.html', 'background.js', 'content.js', 'popup.js')
        foreach ($name in $required) {
            if (-not (Test-Path -LiteralPath (Join-Path $output $name))) { throw "dist/extension/$name is missing." }
        }
        $own = $required + @('background.js.map', 'content.js.map', 'popup.js.map')
        $stale = [System.Collections.Generic.List[string]]::new()
        $bundles = @(Get-ChildItem -LiteralPath $output -Recurse -File | Where-Object { $_.Extension -in '.js', '.css', '.map' })
        foreach ($bundle in $bundles) {
            $relative = [System.IO.Path]::GetRelativePath($output, $bundle.FullName)
            if ($own -contains $relative) { continue }
            # Anything else is a copy of dist/web; a leftover from an earlier build is not.
            if (-not (Test-Path -LiteralPath (Join-Path $web $relative))) { $stale.Add($relative) }
        }
        if ($stale.Count -gt 0) { throw "dist/extension carries assets this build did not produce: $($stale -join ', ')" }
    }

    function Assert-WebReferences {
        $web = Join-Path $root 'dist/web'
        $indexPath = Join-Path $web 'index.html'
        if (-not (Test-Path -LiteralPath $indexPath)) { throw 'dist/web/index.html is missing; run pnpm build first.' }
        $html = Get-Content -LiteralPath $indexPath -Raw
        $references = [regex]::Matches($html, '(?:src|href)\s*=\s*"([^"]+)"') | ForEach-Object { $_.Groups[1].Value }
        $missing = [System.Collections.Generic.List[string]]::new()
        $checked = 0
        $prefix = $web.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
        foreach ($reference in $references) {
            # Absolute URLs, protocol-relative URLs and fragments are not build output.
            if ($reference -match '^(?:[a-z][a-z0-9+.-]*:|//|#)') { continue }
            $relative = [System.Uri]::UnescapeDataString(($reference -split '[?#]')[0])
            $checked++
            $resolved = [System.IO.Path]::GetFullPath((Join-Path $web $relative))
            if (-not $resolved.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) { throw "dist/web/index.html references a path outside dist/web: $reference" }
            if (-not (Test-Path -LiteralPath $resolved)) { $missing.Add($reference) }
        }
        if ($checked -eq 0) { throw 'dist/web/index.html references no local files; the build output looks wrong.' }
        if ($missing.Count -gt 0) { throw "dist/web/index.html references files that do not exist: $($missing -join ', ')" }
    }

    if (-not $ArtifactsOnly) {
        Step 'unit' { pnpm test; if ($LASTEXITCODE -ne 0) { throw 'unit tests failed' } }
        Step 'typecheck' { pnpm typecheck; if ($LASTEXITCODE -ne 0) { throw 'typecheck failed' } }
        Step 'build' { pnpm build; if ($LASTEXITCODE -ne 0) { throw 'build failed' } }
        # Retries stay pinned to 0 so a flaky run cannot buy a green release gate.
        Step 'e2e' { pnpm exec playwright test --retries=0; if ($LASTEXITCODE -ne 0) { throw 'e2e failed' } }
    }
    Step 'extension artifacts' { Assert-ExtensionOutput }
    Step 'web references' { Assert-WebReferences }

    $results | Format-Table -AutoSize | Out-String | Write-Output
    Write-Output "Release gate passed: $($results.Count) checks in $([math]::Round(($results | Measure-Object -Property Seconds -Sum).Sum, 1))s."
} finally {
    Pop-Location
}
