$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$runtime = Join-Path $root 'runtime'
New-Item -ItemType Directory -Force $runtime | Out-Null
$release = Invoke-RestMethod 'https://api.github.com/repos/bblanchon/pdfium-binaries/releases/tags/chromium%2F8125'
$asset = $release.assets | Where-Object name -eq 'pdfium-win-x64.tgz'
if (-not $asset -or -not $asset.digest.StartsWith('sha256:')) { throw 'Pinned PDFium asset or checksum unavailable.' }
$archive = Join-Path $runtime 'pdfium-win-x64.tgz'
Invoke-WebRequest $asset.browser_download_url -OutFile $archive
$actual = (Get-FileHash $archive -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne $asset.digest.Substring(7)) { throw 'PDFium archive checksum mismatch.' }
& tar -xzf $archive -C $runtime
if ($LASTEXITCODE -ne 0) { throw 'PDFium extraction failed.' }
$asset.digest | Set-Content (Join-Path $runtime 'archive.sha256')
Write-Output "PDFium chromium/8125 ready at $runtime. Preserve licenses when packaging."
