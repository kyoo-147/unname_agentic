param([switch]$LayoutSamples, [string]$Pdf)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$executable = Join-Path $root 'native-shell\target\debug\pdf_workspace.exe'
if (-not (Test-Path $executable)) { throw 'Build the GPUI native shell before launching the preview.' }
$env:PDF_WORKSPACE_HOME = Join-Path $root 'artifacts\product-library'
$env:PDF_WORKSPACE_DATA = Join-Path $root 'artifacts\product-services'
$env:PDF_WORKSPACE_LAYOUT_PREVIEW = if ($LayoutSamples) { '1' } else { '0' }
Remove-Item Env:FDL_SCRIPT -ErrorAction SilentlyContinue
$arguments = @{ FilePath = $executable; WorkingDirectory = (Split-Path -Parent $executable); PassThru = $true }
if ($Pdf) { $arguments.ArgumentList = '"' + (Resolve-Path $Pdf).Path + '"' }
$process = Start-Process @arguments
Write-Output "Native GPUI preview launched. PID=$($process.Id) EXE=$executable"
Write-Output "Isolated preview library: $env:PDF_WORKSPACE_HOME"
