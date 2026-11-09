param(
    [ValidateSet('check', 'test', 'build', 'run', 'clippy')]
    [string]$Action = 'build',
    [switch]$Release
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
if (-not (Test-Path $vswhere)) { throw 'Visual Studio Installer discovery tool is missing.' }
$installation = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $installation) { throw 'Install Visual Studio C++ Build Tools and the Windows SDK first.' }
$developer = Join-Path $installation 'Common7\Tools\VsDevCmd.bat'
$manifest = Join-Path $root 'desktop\Cargo.toml'
if (-not (Test-Path $manifest)) { throw 'The desktop Cargo manifest does not exist yet.' }
$releaseFlag = if ($Release -and $Action -in @('build', 'run', 'test')) { '--release' } else { '' }
$commandLine = 'call "{0}" -arch=x64 -host_arch=x64 >nul && cargo {1} --manifest-path "{2}" {3}' -f $developer, $Action, $manifest, $releaseFlag
& $env:ComSpec /d /s /c $commandLine
if ($LASTEXITCODE -ne 0) { throw "Native $Action failed with exit code $LASTEXITCODE." }
