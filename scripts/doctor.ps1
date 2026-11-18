$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Write-Output "Workspace: $root"
foreach ($tool in @('node', 'pnpm', 'git', 'rustup', 'cargo')) {
    $command = Get-Command $tool -ErrorAction SilentlyContinue
    if (-not $command) { throw "Missing required tool: $tool" }
    Write-Output "$tool : $($command.Source)"
}
& node --version
& pnpm --version
& cargo --version
if ($LASTEXITCODE -ne 0) { throw 'The pinned Rust toolchain is unavailable.' }
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
if (-not (Test-Path $vswhere)) { throw 'Visual Studio Installer discovery tool is missing.' }
$installation = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $installation) { throw 'C++ Build Tools or the Windows SDK is missing.' }
Write-Output "MSVC environment: $installation"
Write-Output 'Run native Cargo commands through scripts/build-windows.ps1 to select the MSVC linker.'
Write-Output 'Provider credentials and local OCR/model availability are verified separately in the application.'
