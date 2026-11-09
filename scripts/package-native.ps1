[CmdletBinding()]
param([switch]$DebugBuild)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$profile = if ($DebugBuild) { 'debug' } else { 'release' }
$application = Join-Path $root "native-shell\target\$profile\pdf_workspace.exe"
$companion = Join-Path $root "desktop\target\$profile\pdf-workspace-host.exe"
$pdfium = Join-Path $root 'desktop\runtime\bin\pdfium.dll'
foreach ($file in @($application, $companion, $pdfium)) { if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Build the $profile artifacts first: $file" } }
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$folder = Join-Path $root "dist\pdf-workspace-windows-x64-$profile-$stamp"
if (Test-Path -LiteralPath $folder) { throw 'The package directory already exists; no existing package was changed.' }
New-Item -ItemType Directory -Path $folder | Out-Null
Copy-Item -LiteralPath $application -Destination (Join-Path $folder 'pdf_workspace.exe')
Copy-Item -LiteralPath $companion -Destination (Join-Path $folder 'pdf-workspace-host.exe')
Copy-Item -LiteralPath $pdfium -Destination (Join-Path $folder 'pdfium.dll')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'install-native-host.ps1') -Destination $folder
Copy-Item -LiteralPath (Join-Path $root 'native-shell\LICENSE') -Destination (Join-Path $folder 'LICENSE-UPSTREAM.txt')
Copy-Item -LiteralPath (Join-Path $root 'native-shell\assets-safe\LICENSE-LUCIDE.txt') -Destination $folder
$notices = Join-Path $folder 'third-party-notices'
New-Item -ItemType Directory -Path $notices | Out-Null
Copy-Item -LiteralPath (Join-Path $root 'desktop\runtime\LICENSE') -Destination (Join-Path $notices 'PDFIUM-LICENSE.txt')
Copy-Item -LiteralPath (Join-Path $root 'desktop\runtime\licenses') -Destination (Join-Path $notices 'pdfium-components') -Recurse
Copy-Item -LiteralPath (Join-Path $root 'desktop\runtime\VERSION') -Destination (Join-Path $notices 'PDFIUM-VERSION')
$licenses = @{}
foreach ($manifest in @('native-shell\Cargo.toml', 'desktop\Cargo.toml')) {
    $json = & cargo metadata --locked --format-version 1 --filter-platform x86_64-pc-windows-msvc --manifest-path (Join-Path $root $manifest)
    if ($LASTEXITCODE -ne 0) { throw 'Cargo metadata failed; the incomplete package is not a release.' }
    $metadata = ($json -join "`n") | ConvertFrom-Json
    foreach ($package in $metadata.packages) {
        $key = "$($package.name)-$($package.version)"
        if ($licenses.ContainsKey($key)) { continue }
        $packageRoot = Split-Path -Parent $package.manifest_path
        $destination = Join-Path $notices $key
        New-Item -ItemType Directory -Path $destination | Out-Null
        $files = @(Get-ChildItem -LiteralPath $packageRoot -File | Where-Object { $_.Name -match '^(LICENSE|LICENCE|NOTICE|COPYING|UNLICENSE)' -and $_.Length -le 1048576 })
        if ($package.license_file) {
            $declared = Join-Path $packageRoot $package.license_file
            if (Test-Path -LiteralPath $declared -PathType Leaf) { $files += Get-Item -LiteralPath $declared }
        }
        $files | Sort-Object FullName -Unique | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $destination }
        $licenses[$key] = [ordered]@{ name=$package.name; version=$package.version; license=$package.license; repository=$package.repository; notice_files=@($files | ForEach-Object Name) }
    }
}
$licenses.Values | Sort-Object name,version | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $notices 'DEPENDENCIES.json') -Encoding utf8
@'
PDF Workspace - native Windows preview

Open pdf_workspace.exe. No administrator account or login is required.
Import a PDF with the + button, Ctrl+O, drag-and-drop, or by passing its path to the executable.
The sidebar, Home library, and custom titlebar are the approved native GPUI shell.

Documents/settings use separate LocalAppData/PdfWorkspace folders, never the original Quiet.md library.
Translation is off until a provider is configured. Local mode requires your own running loopback model server.
Cloud translation needs your credentials and explicit text-transfer consent. No model or cloud quota is bundled.
OCR is local; uncertain raster artwork is retained with paired text, not erased with a rectangular mask.

Chrome companion (optional): keep this app open; load the separately packaged extension.
From chrome://extensions copy the installed extension ID, then run:
powershell -File .\install-native-host.ps1 -ExtensionId <32-character-ID> -HostPath <full-path-to-pdf-workspace-host.exe>
This writes only this user's exact Chrome NativeMessagingHosts/com.pdfworkspace.bridge entry.
Then use Open in desktop in the extension popup. Stop/detach remains explicit.
No registry entry is installed merely by opening this package.

Requirements: Windows 10/11 x64 with graphics acceleration and Microsoft Visual C++ 2015-2022 x64 runtime.
Windows OCR language packs are required for captured/scanned content. The MSVC runtime is not redistributed here.
No Electron or WebView is used for the product shell. The source fork retains inactive upstream editor/printing modules.

This preview is not a universal PDF fidelity or translation-quality certification.
Clipped/Type3 text, complex raster masks, all language scripts and mixed-DPI capture remain acceptance work.
Third-party source licenses/notices are included; upstream commercial icons and app branding are not embedded.
'@ | Set-Content -LiteralPath (Join-Path $folder 'README.txt') -Encoding utf8
$hashes = Get-ChildItem -LiteralPath $folder -Recurse -File | ForEach-Object {
    [ordered]@{ path=$_.FullName.Substring($folder.Length + 1).Replace('\','/'); sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant(); bytes=$_.Length }
}
[ordered]@{ profile=$profile; created=(Get-Date -Format o); files=@($hashes); note='Build artifact manifest, not a fidelity or translation-quality certificate.' } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $folder 'MANIFEST.json') -Encoding utf8
foreach ($file in Get-ChildItem -LiteralPath $folder -Recurse -File) {
    if ($file.LastWriteTimeUtc.Year -lt 1980 -or $file.LastWriteTimeUtc.Year -gt 2107) { $file.LastWriteTimeUtc = [datetime]'1980-01-01T00:00:00Z' }
}
$zip = "$folder.zip"
if (Test-Path -LiteralPath $zip) { throw 'The archive already exists; no existing archive was replaced.' }
Add-Type -AssemblyName System.IO.Compression.FileSystem
# Compress-Archive writes backslash entry names and merges into an existing
# archive; ZipFile writes portable names and cannot append duplicates.
[IO.Compression.ZipFile]::CreateFromDirectory($folder, $zip, [IO.Compression.CompressionLevel]::Optimal, $true)
$archive = [IO.Compression.ZipFile]::OpenRead($zip)
try {
    $expected = @(Get-ChildItem -LiteralPath $folder -Recurse -File)
    $actual = @($archive.Entries | Where-Object { -not ($_.FullName.EndsWith('/') -or $_.FullName.EndsWith('\')) })
    if ($actual.Count -ne $expected.Count) { throw "Archive has $($actual.Count) files, package has $($expected.Count)." }
    $index = @{}
    foreach ($entry in $actual) { $index[$entry.FullName.Replace('\','/')] = $entry }
    foreach ($file in $expected) {
        $relative = $file.FullName.Substring($folder.Length + 1).Replace('\','/')
        $entry = $index[(Split-Path -Leaf $folder) + '/' + $relative]
        if (-not $entry -or $entry.Length -ne $file.Length) { throw "Archive entry is missing or incomplete: $relative" }
    }
} finally { $archive.Dispose() }
Write-Output "PACKAGE=$folder"
Write-Output "ZIP=$zip"
