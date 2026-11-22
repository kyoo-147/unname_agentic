[CmdletBinding()]
param(
    [switch]$DebugBuild,
    [switch]$DryRun,
    [switch]$AllowDirty,
    [string]$OutputDirectory,
    [string]$NativeTargetDirectory,
    [string]$DesktopTargetDirectory
)

$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$profile = if ($DebugBuild) { 'debug' } else { 'release' }

function Write-Utf8NoBom([string]$Path, [string]$Text) {
    [IO.File]::WriteAllText($Path, $Text, [Text.UTF8Encoding]::new($false))
}

function Git-Value([string[]]$Arguments) {
    $value = (& git -C $root @Arguments 2>$null | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($value)) { throw "git $($Arguments -join ' ') failed." }
    return $value
}

function Resolve-RootPath([string]$Path) {
    if ([IO.Path]::IsPathRooted($Path)) { return [IO.Path]::GetFullPath($Path) }
    return [IO.Path]::GetFullPath((Join-Path $root $Path))
}

function Require-File([string]$Path, [string]$Label) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "$Label is missing: $Path" }
}

function Relative([string]$Base, [string]$Path) {
    return $Path.Substring($Base.Length + 1).Replace('\', '/')
}

function Read-Version {
    $match = Select-String -LiteralPath (Join-Path $root 'native-shell/Cargo.toml') -Pattern '^version\s*=\s*"([^"]+)"' | Select-Object -First 1
    if (-not $match) { throw 'native-shell/Cargo.toml has no package version.' }
    return $match.Matches[0].Groups[1].Value
}

function Read-WebVersion {
    $package = Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
    if ([string]::IsNullOrWhiteSpace($package.version)) { throw 'package.json has no release version.' }
    return $package.version.Trim()
}

function Test-PackageIdentity([string]$Folder, [string]$Commit, [string]$Profile) {
    $manifestPath = Join-Path $Folder 'MANIFEST.json'
    $zipPath = "$Folder.zip"
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf) -or
        -not (Test-Path -LiteralPath $zipPath -PathType Leaf)) { return $false }
    try {
        $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
        return $manifest.schema -eq 1 -and
            $manifest.profile -eq $Profile -and
            $manifest.source.commit -eq $Commit -and
            (Test-Path -LiteralPath (Join-Path $Folder 'CHECKSUMS.sha256') -PathType Leaf) -and
            (Test-Path -LiteralPath (Join-Path $Folder 'pdf_workspace.exe') -PathType Leaf) -and
            (Test-Path -LiteralPath (Join-Path $Folder 'pdf-workspace-host.exe') -PathType Leaf) -and
            (Test-Path -LiteralPath (Join-Path $Folder 'pdfium.dll') -PathType Leaf)
    } catch { return $false }
}

$commit = Git-Value @('rev-parse', 'HEAD')
$shortCommit = if ($commit.Length -ge 12) { $commit.Substring(0, 12) } else { $commit }
$dirtyText = (& git -C $root status --porcelain --untracked-files=no 2>$null | Out-String).Trim()
$dirty = -not [string]::IsNullOrWhiteSpace($dirtyText)
if ($dirty -and -not $AllowDirty) {
    throw "The source worktree is dirty. Commit the release inputs first or pass -AllowDirty; package provenance must be explicit."
}

$version = Read-Version
$webVersion = Read-WebVersion
if ($version -ne $webVersion) { throw "Native version $version does not match web package version $webVersion; refusing a mixed-revision release." }
$nativeTarget = if ($NativeTargetDirectory) { Resolve-RootPath $NativeTargetDirectory } else { Join-Path $root "native-shell/target/$profile" }
$desktopTarget = if ($DesktopTargetDirectory) { Resolve-RootPath $DesktopTargetDirectory } else { Join-Path $root "desktop/target/$profile" }
$application = Join-Path $nativeTarget 'pdf_workspace.exe'
$pdfium = Join-Path $root 'desktop/runtime/bin/pdfium.dll'
$nativeHost = Join-Path $desktopTarget 'pdf-workspace-host.exe'
$inputs = [ordered]@{
    'GPUI executable' = $application
    'PDFium runtime' = $pdfium
    'native messaging host' = $nativeHost
    'native host installer' = (Join-Path $PSScriptRoot 'install-native-host.ps1')
    'root license' = (Join-Path $root 'LICENSE')
    'native shell license' = (Join-Path $root 'native-shell/LICENSE')
    'PDFium license' = (Join-Path $root 'desktop/runtime/LICENSE')
    'PDFium version' = (Join-Path $root 'desktop/runtime/VERSION')
}

$output = if ($OutputDirectory) { Resolve-RootPath $OutputDirectory } else { Join-Path $root "dist/pdf-workspace-windows-x64-$profile-$shortCommit" }
$zip = "$output.zip"

Write-Output "PROFILE=$profile"
Write-Output "VERSION=$version"
Write-Output "WEB_VERSION=$webVersion"
Write-Output "COMMIT=$commit"
Write-Output "OUTPUT=$output"
if ($dirty) { Write-Output 'SOURCE_DIRTY=1' } else { Write-Output 'SOURCE_DIRTY=0' }

if ($DryRun) {
    $missing = @($inputs.GetEnumerator() | Where-Object { -not (Test-Path -LiteralPath $_.Value -PathType Leaf) })
    foreach ($item in $inputs.GetEnumerator()) {
        $state = if (Test-Path -LiteralPath $item.Value -PathType Leaf) { 'present' } else { 'missing' }
        Write-Output ("DRY_RUN_{0}={1}" -f ($item.Key.ToUpperInvariant().Replace(' ', '_')), $state)
    }
    if ($missing.Count -gt 0) { throw ("Dry-run blocked; missing inputs: " + (($missing | ForEach-Object { $_.Key }) -join ', ')) }
    if (Test-Path -LiteralPath $output) {
        if (Test-PackageIdentity $output $commit $profile) { Write-Output "IDEMPOTENT=existing package is for commit $commit" }
        else { throw "Dry-run found an existing package path with a different or incomplete provenance record: $output" }
    } elseif (Test-Path -LiteralPath $zip) {
        throw "Dry-run found an archive without its package directory: $zip"
    } else {
        Write-Output 'DRY_RUN=ready to stage package; no files were written.'
    }
    exit 0
}

foreach ($item in $inputs.GetEnumerator()) { Require-File $item.Value $item.Key }
if (Test-Path -LiteralPath $output) {
    if (Test-PackageIdentity $output $commit $profile) {
        Write-Output "IDEMPOTENT=existing package is for commit $commit"
        Write-Output "PACKAGE=$output"
        Write-Output "ZIP=$zip"
        exit 0
    }
    throw "The package directory exists but is not a complete package for commit ${commit}: $output"
}
if (Test-Path -LiteralPath $zip) { throw "The archive exists without a matching package directory: $zip" }

$parent = Split-Path -Parent $output
New-Item -ItemType Directory -Force -Path $parent | Out-Null
$stage = Join-Path $parent ('.package-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage | Out-Null
try {
    Copy-Item -LiteralPath $application -Destination (Join-Path $stage 'pdf_workspace.exe')
    Copy-Item -LiteralPath $pdfium -Destination (Join-Path $stage 'pdfium.dll')
    Copy-Item -LiteralPath $nativeHost -Destination (Join-Path $stage 'pdf-workspace-host.exe')
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'install-native-host.ps1') -Destination $stage
    Copy-Item -LiteralPath (Join-Path $root 'LICENSE') -Destination (Join-Path $stage 'LICENSE.txt')
    Copy-Item -LiteralPath (Join-Path $root 'native-shell/LICENSE') -Destination (Join-Path $stage 'LICENSE-UPSTREAM.txt')
    Copy-Item -LiteralPath (Join-Path $root 'native-shell/THIRD_PARTY.md') -Destination (Join-Path $stage 'THIRD_PARTY-SOURCE.md')
    Copy-Item -LiteralPath (Join-Path $root 'native-shell/assets') -Destination (Join-Path $stage 'assets') -Recurse
    Copy-Item -LiteralPath (Join-Path $root 'native-shell/assets-safe') -Destination (Join-Path $stage 'assets-safe') -Recurse

    $notices = Join-Path $stage 'third-party-notices'
    New-Item -ItemType Directory -Path $notices | Out-Null
    Copy-Item -LiteralPath (Join-Path $root 'desktop/runtime/LICENSE') -Destination (Join-Path $notices 'PDFIUM-LICENSE.txt')
    Copy-Item -LiteralPath (Join-Path $root 'desktop/runtime/licenses') -Destination (Join-Path $notices 'pdfium-components') -Recurse
    Copy-Item -LiteralPath (Join-Path $root 'desktop/runtime/VERSION') -Destination (Join-Path $notices 'PDFIUM-VERSION')
    Copy-Item -LiteralPath (Join-Path $root 'native-shell/assets-safe/LICENSE-LUCIDE.txt') -Destination (Join-Path $notices 'LUCIDE-LICENSE.txt')
    @'
The native Windows build uses the Windows OCR API for local OCR.
No OCR or translation model weights are bundled in this package.
Windows OCR language packs are an operating-system prerequisite for scanned-content OCR.
Translation is manual-check only: the app never installs an update or model automatically.
Any configured provider, model, quota and data-transfer policy remains the user's responsibility.
'@ | Set-Content -LiteralPath (Join-Path $notices 'OCR-MODEL-NOTICE.txt') -Encoding UTF8

    $nativeMessaging = Join-Path $stage 'native-messaging'
    New-Item -ItemType Directory -Path $nativeMessaging | Out-Null
    @'
{
  "name": "com.pdfworkspace.bridge",
  "description": "PDF Workspace opt-in local PDF inbox bridge",
  "path": "REPLACE_WITH_ABSOLUTE_PATH_TO_pdf-workspace-host.exe",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://REPLACE_WITH_32_CHARACTER_EXTENSION_ID/"]
}
'@ | Set-Content -LiteralPath (Join-Path $nativeMessaging 'com.pdfworkspace.bridge.template.json') -Encoding UTF8

    $metadataRecords = @{}
    foreach ($manifestPath in @('native-shell/Cargo.toml', 'desktop/Cargo.toml')) {
        $manifest = Join-Path $root $manifestPath
        $jsonLines = & cargo metadata --locked --format-version 1 --filter-platform x86_64-pc-windows-msvc --manifest-path $manifest 2>&1
        if ($LASTEXITCODE -ne 0) { throw "cargo metadata failed for $manifestPath; the incomplete package is not a release." }
        $metadata = ($jsonLines -join "`n") | ConvertFrom-Json
        foreach ($package in $metadata.packages) {
            $key = "$($package.name)-$($package.version)"
            if ($metadataRecords.ContainsKey($key)) { continue }
            $packageRoot = Split-Path -Parent $package.manifest_path
            $destination = Join-Path $notices $key
            New-Item -ItemType Directory -Force -Path $destination | Out-Null
            $files = @(Get-ChildItem -LiteralPath $packageRoot -File | Where-Object { $_.Name -match '^(LICENSE|LICENCE|NOTICE|COPYING|UNLICENSE)' -and $_.Length -le 1048576 })
            if ($package.license_file) {
                $declared = Join-Path $packageRoot $package.license_file
                if (Test-Path -LiteralPath $declared -PathType Leaf) { $files += Get-Item -LiteralPath $declared }
            }
            foreach ($file in ($files | Sort-Object FullName -Unique)) { Copy-Item -LiteralPath $file.FullName -Destination $destination -Force }
            $metadataRecords[$key] = [ordered]@{
                name = $package.name
                version = $package.version
                license = $package.license
                repository = $package.repository
                notice_files = @($files | Sort-Object FullName -Unique | ForEach-Object Name)
            }
        }
    }
    $metadataRecords.Values | Sort-Object name, version | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $notices 'DEPENDENCIES.json') -Encoding UTF8

    @"
PDF Workspace - native Windows preview

This package contains the native GPUI executable, its PDFium runtime, the Chrome
native-messaging host, embedded asset sources for audit, licenses and checksums.
Open pdf_workspace.exe. No administrator account or login is required.

The optional Chrome companion is not registered automatically. Load the separately
built extension, copy its exact extension ID, then run:
powershell -NoProfile -File .\install-native-host.ps1 -ExtensionId <32-character-ID> -HostPath <full-path-to-pdf-workspace-host.exe>
The installer writes only this user's exact Chrome NativeMessagingHosts entry.
The native-messaging template under native-messaging/ is documentation; do not register it
without replacing both placeholders. No registry entry is installed merely by opening this package.

Update behavior is intentionally manual-check only. A release may expose a signed minisign
manifest and a release-page link, but this build never downloads, replaces or simulates an update.
When no manifest and embedded public key are configured, Settings visibly says that updates are
not configured and no network request is made.

Requirements: Windows 10/11 x64 with graphics acceleration, Microsoft Visual C++ 2015-2022
x64 runtime, and Windows OCR language packs for captured/scanned content. No OCR or translation
model weights are bundled. No credentials, provider configuration or user documents are included.

This preview is not universal PDF fidelity or translation-quality certification.
The MANIFEST.json records the source commit and per-file SHA-256 hashes; CHECKSUMS.sha256 is the
portable checksum list for the package files. The package was assembled from one source revision.
"@ | Set-Content -LiteralPath (Join-Path $stage 'README.txt') -Encoding UTF8

    $packageFiles = @(Get-ChildItem -LiteralPath $stage -Recurse -File | Where-Object { $_.Name -notin @('MANIFEST.json', 'CHECKSUMS.sha256') })
    $fileRecords = @($packageFiles | Sort-Object FullName | ForEach-Object {
        [ordered]@{ path = Relative $stage $_.FullName; sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant(); bytes = $_.Length }
    })
    $manifestObject = [ordered]@{
        schema = 1
        application = 'pdf_workspace'
        version = $version
        profile = $profile
        platform = 'windows-x64'
        source = [ordered]@{ commit = $commit; dirty = $dirty; dirty_files = if ($dirty) { @($dirtyText -split "`r?`n" | Where-Object { $_ }) } else { @() } }
        update = [ordered]@{ mode = 'manual-check-only'; automatic_install = $false; signature = 'minisign manifest verification is required when an update source is configured' }
        files = $fileRecords
        note = 'Build artifact manifest, not a fidelity or translation-quality certificate.'
    }
    $manifestPath = Join-Path $stage 'MANIFEST.json'
    $manifestObject | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $manifestPath -Encoding UTF8

    $checksumFiles = @(Get-ChildItem -LiteralPath $stage -Recurse -File | Where-Object { $_.Name -ne 'CHECKSUMS.sha256' } | Sort-Object FullName)
    $checksumLines = @($checksumFiles | ForEach-Object {
        $hash = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        "$hash  $(Relative $stage $_.FullName)"
    })
    Write-Utf8NoBom (Join-Path $stage 'CHECKSUMS.sha256') (($checksumLines -join "`n") + "`n")

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::CreateFromDirectory($stage, $zip, [IO.Compression.CompressionLevel]::Optimal, $true)
    $archive = [IO.Compression.ZipFile]::OpenRead($zip)
    try {
        $expected = @(Get-ChildItem -LiteralPath $stage -Recurse -File)
        $actual = @($archive.Entries | Where-Object { -not ($_.FullName.EndsWith('/') -or $_.FullName.EndsWith('\')) })
        if ($actual.Count -ne $expected.Count) { throw "Archive has $($actual.Count) files, package has $($expected.Count)." }
        foreach ($file in $expected) {
            $entryName = (Split-Path -Leaf $stage) + '/' + (Relative $stage $file.FullName)
            if (-not ($actual | Where-Object FullName -eq $entryName)) { throw "Archive entry is missing: $(Relative $stage $file.FullName)" }
        }
    } finally { $archive.Dispose() }

    Move-Item -LiteralPath $stage -Destination $output
    Write-Output "PACKAGE=$output"
    Write-Output "ZIP=$zip"
    Write-Output "CHECKSUMS=$output/CHECKSUMS.sha256"
} finally {
    if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
}
