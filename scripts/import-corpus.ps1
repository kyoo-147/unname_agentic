param([string]$App = 'D:\work\mirror_trans_pdf\native-shell\target\debug\pdf_workspace.exe', [string]$Library = 'D:\work\mirror_trans_pdf\artifacts\corpus-library')
$ErrorActionPreference = 'Stop'
$corpus = Join-Path (Split-Path -Parent $PSScriptRoot) 'artifacts\test-corpus'
$pdfs = @(Get-ChildItem -LiteralPath $corpus -Filter *.pdf | Sort-Object Name | ForEach-Object FullName)
if ($pdfs.Count -eq 0) { throw 'No corpus PDFs found; run scripts/fetch-test-corpus.mjs first.' }
New-Item -ItemType Directory -Path $Library -Force | Out-Null
$env:PDF_WORKSPACE_HOME = $Library
$env:PDF_WORKSPACE_DATA = Join-Path $Library '..\corpus-services'
$env:PDF_WORKSPACE_INBOX = Join-Path $Library '..\corpus-inbox'
$env:PDF_WORKSPACE_LAYOUT_PREVIEW = '0'
Remove-Item Env:FDL_SCRIPT -ErrorAction SilentlyContinue
Write-Output "Importing $($pdfs.Count) PDFs into $Library"
$process = Start-Process -FilePath $App -ArgumentList $pdfs -WorkingDirectory (Split-Path -Parent $App) -PassThru
$index = Join-Path $Library 'documents\index.json'
$deadline = (Get-Date).AddMinutes(6)
do {
    Start-Sleep -Seconds 3
    $count = 0
    if (Test-Path $index) {
        try { $json = Get-Content -Raw $index | ConvertFrom-Json; $count = @($json.PSObject.Properties).Count } catch { $count = 0 }
    }
    Write-Output "indexed=$count"
} while ($count -lt $pdfs.Count -and (Get-Date) -lt $deadline -and -not $process.HasExited)
Write-Output "PID=$($process.Id) TITLE=$((Get-Process -Id $process.Id -ErrorAction SilentlyContinue).MainWindowTitle) INDEXED=$count"
if ($count -lt $pdfs.Count) { throw "Only $count of $($pdfs.Count) PDFs were indexed." }
