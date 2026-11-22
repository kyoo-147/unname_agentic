<#
.SYNOPSIS
Run the release gate and print one per-check table.

.DESCRIPTION
Runs extension tests, typecheck and build, then checks the extension output and, for a full
release verification, requires a commit-bound native package with checksums and archive.

  * dist/extension has a Manifest V3 manifest, the viewer bundles and the PDF worker.
  * dist/extension/index.html references only files that exist in dist/extension.
  * Full verification requires a commit-bound native package; -ArtifactsOnly is extension-only.

The first failing check stops the gate, prints the table, and exits 1.
Runs unchanged in Windows PowerShell 5.1 and PowerShell 7 (CI uses pwsh).

.PARAMETER ArtifactsOnly
Check existing dist/extension output without running tests, typecheck, build or native-package verification.

.PARAMETER RequireNativePackage
Require and verify the native GPUI package in dist, including MANIFEST.json, checksums and zip.

.PARAMETER DryRun
Print the selected verification mode without executing checks or changing files.

.EXAMPLE
pwsh -File scripts/verify-release.ps1

.EXAMPLE
pwsh -File scripts/verify-release.ps1 -ArtifactsOnly

.EXAMPLE
pwsh -File scripts/verify-release.ps1 -RequireNativePackage
#>
[CmdletBinding()]
param(
    [switch]$ArtifactsOnly,
    [switch]$DryRun,
    [switch]$RequireNativePackage,
    [string]$PackagePath
)
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

    function Get-RelativePath([string]$Base, [string]$Full) {
        $prefix = $Base.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
        if (-not $Full.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) { throw "$Full is not inside $Base" }
        return $Full.Substring($prefix.Length)
    }

    function Assert-ExtensionOutput {
        $output = [System.IO.Path]::GetFullPath((Join-Path $root 'dist/extension'))
        if (-not (Test-Path -LiteralPath $output)) { throw 'dist/extension is missing; run pnpm build first.' }
        $manifestPath = Join-Path $output 'manifest.json'
        if (-not (Test-Path -LiteralPath $manifestPath)) { throw 'dist/extension/manifest.json is missing.' }
        $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
        if ($manifest.manifest_version -ne 3) { throw "dist/extension/manifest.json is not Chrome MV3 (manifest_version=$($manifest.manifest_version))." }
        $required = @('manifest.json', 'popup.html', 'background.js', 'content.js', 'popup.js', 'index.html', 'index.js', 'index.css', 'assets/pdf.worker.min.mjs')
        foreach ($name in $required) {
            if (-not (Test-Path -LiteralPath (Join-Path $output $name) -PathType Leaf)) { throw "dist/extension/$name is missing." }
        }
        $manifestWorker = [string]$manifest.background.service_worker
        if ($manifestWorker -ne 'background.js') { throw "Manifest background service worker is '$manifestWorker', expected background.js." }
    }

    function Assert-ExtensionReferences {
        $output = [System.IO.Path]::GetFullPath((Join-Path $root 'dist/extension'))
        $files = @(
            (Join-Path $output 'index.html'),
            (Join-Path $output 'popup.html')
        )
        $missing = [System.Collections.Generic.List[string]]::new()
        foreach ($htmlPath in $files) {
            if (-not (Test-Path -LiteralPath $htmlPath -PathType Leaf)) { throw "$(Get-RelativePath $root $htmlPath) is missing." }
            $html = Get-Content -LiteralPath $htmlPath -Raw
            $references = [regex]::Matches($html, '(?:src|href)\s*=\s*["'']([^"'']+)["'']') | ForEach-Object { $_.Groups[1].Value }
            $checked = 0
            foreach ($reference in $references) {
                if ($reference -match '^(?:[a-z][a-z0-9+.-]*:|//|#)') { continue }
                $relative = [System.Uri]::UnescapeDataString(($reference -split '[?#]')[0])
                $resolved = [System.IO.Path]::GetFullPath((Join-Path $output $relative))
                $null = Get-RelativePath $output $resolved
                $checked++
                if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) { $missing.Add("$(Get-RelativePath $root $htmlPath) -> $reference") }
            }
            if ($checked -eq 0) { throw "$(Get-RelativePath $root $htmlPath) references no local files; the extension output looks wrong." }
        }
        if ($missing.Count -gt 0) { throw "dist/extension contains missing HTML references: $($missing -join ', ')" }
    }

    function Assert-NativePackage {
        $candidate = if ($PackagePath) {
            if ([System.IO.Path]::IsPathRooted($PackagePath)) { [System.IO.Path]::GetFullPath($PackagePath) }
            else { [System.IO.Path]::GetFullPath((Join-Path $root $PackagePath)) }
        } else {
            $dist = Join-Path $root 'dist'
            if (-not (Test-Path -LiteralPath $dist -PathType Container)) { throw 'dist is missing; pass -PackagePath or run scripts/package-native.ps1.' }
            $found = @(Get-ChildItem -LiteralPath $dist -Directory | Where-Object { $_.Name -match '^pdf-workspace-windows-x64-release-' } | Sort-Object LastWriteTimeUtc -Descending)
            if ($found.Count -eq 0) { throw 'No native release package directory exists under dist; run scripts/package-native.ps1.' }
            $found[0].FullName
        }
        if (-not (Test-Path -LiteralPath $candidate -PathType Container)) { throw "Native package directory is missing: $candidate" }
        $manifestPath = Join-Path $candidate 'MANIFEST.json'
        $checksumPath = Join-Path $candidate 'CHECKSUMS.sha256'
        $zipPath = "$candidate.zip"
        foreach ($path in @($manifestPath, $checksumPath, $zipPath)) {
            if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Native package evidence is missing: $path" }
        }
        $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
        if ($manifest.schema -ne 1 -or [string]::IsNullOrWhiteSpace($manifest.source.commit)) { throw 'Native package MANIFEST.json has no usable source commit.' }
        if ($manifest.profile -ne 'release') { throw "Native package profile is '$($manifest.profile)', not release." }
        $required = @('pdf_workspace.exe', 'pdfium.dll', 'pdf-workspace-host.exe', 'install-native-host.ps1', 'README.txt', 'native-messaging/com.pdfworkspace.bridge.template.json')
        foreach ($relative in $required) {
            if (-not (Test-Path -LiteralPath (Join-Path $candidate ($relative -replace '/', '\')) -PathType Leaf)) { throw "Native package file is missing: $relative" }
        }
        foreach ($record in @($manifest.files)) {
            $relative = [string]$record.path
            if ([string]::IsNullOrWhiteSpace($relative) -or $relative.Contains('..') -or [IO.Path]::IsPathRooted($relative)) { throw "Unsafe path in MANIFEST.json: $relative" }
            $file = Join-Path $candidate ($relative -replace '/', '\')
            if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Manifest file is missing: $relative" }
            $actual = Get-FileHash -LiteralPath $file -Algorithm SHA256
            if ($actual.Hash.ToLowerInvariant() -ne ([string]$record.sha256).ToLowerInvariant() -or (Get-Item -LiteralPath $file).Length -ne [int64]$record.bytes) { throw "Manifest hash or size mismatch: $relative" }
        }
        $checksumLines = @(Get-Content -LiteralPath $checksumPath | Where-Object { $_.Trim().Length -gt 0 })
        if ($checksumLines.Count -eq 0) { throw 'CHECKSUMS.sha256 is empty.' }
        foreach ($line in $checksumLines) {
            if ($line -notmatch '^([0-9a-fA-F]{64})\s{2}(.+)$') { throw "Invalid checksum line: $line" }
            $relative = $Matches[2]
            $file = Join-Path $candidate ($relative -replace '/', '\')
            if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Checksum file is missing: $relative" }
            if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Matches[1].ToLowerInvariant()) { throw "Checksum mismatch: $relative" }
        }
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        $archive = [IO.Compression.ZipFile]::OpenRead($zipPath)
        try {
            $entryNames = @($archive.Entries | Where-Object { -not ($_.FullName.EndsWith('/') -or $_.FullName.EndsWith('\')) } | ForEach-Object FullName)
            foreach ($line in $checksumLines) {
                $relative = [regex]::Match($line, '^([0-9a-fA-F]{64})\s{2}(.+)$').Groups[2].Value
                $expected = (Split-Path -Leaf $candidate) + '/' + $relative
                if ($entryNames -notcontains $expected) { throw "Archive entry is missing: $relative" }
            }
        } finally { $archive.Dispose() }
        Write-Output "Native package source commit: $($manifest.source.commit)"
        Write-Output "Native package files verified: $($checksumLines.Count)"
    }

    if ($DryRun) {
        Write-Output 'DRY_RUN=release verification only; no commands or files will be changed.'
        Write-Output "ARTIFACTS_ONLY=$ArtifactsOnly"
        Write-Output "NATIVE_PACKAGE_REQUIRED=$((-not $ArtifactsOnly) -or $RequireNativePackage -or [bool]$PackagePath)"
        exit 0
    }

    if (-not $ArtifactsOnly) {
        Step 'extension tests' { pnpm test:extension; if ($LASTEXITCODE -ne 0) { throw 'extension tests failed' } }
        Step 'typecheck' { pnpm typecheck; if ($LASTEXITCODE -ne 0) { throw 'typecheck failed' } }
        Step 'build' { pnpm build; if ($LASTEXITCODE -ne 0) { throw 'build failed' } }
    }
    Step 'committed imports' { node scripts/check-committed-imports.mjs; if ($LASTEXITCODE -ne 0) { throw 'a committed file imports a module that is not committed'; } }
    Step 'extension artifacts' { Assert-ExtensionOutput }
    Step 'extension references' { Assert-ExtensionReferences }
    if ((-not $ArtifactsOnly) -or $RequireNativePackage -or $PackagePath) { Step 'native package' { Assert-NativePackage } }

    $results | Format-Table -AutoSize | Out-String | Write-Output
    Write-Output "Release gate passed: $($results.Count) checks in $([math]::Round(($results | Measure-Object -Property Seconds -Sum).Sum, 1))s."
} finally {
    Pop-Location
}
