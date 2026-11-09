param([switch]$Release, [switch]$Test)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$installation = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $installation) { throw 'Visual Studio C++ Build Tools and Windows SDK are required.' }
$developer = Join-Path $installation 'Common7\Tools\VsDevCmd.bat'
$manifest = Join-Path $root 'native-shell\Cargo.toml'
$action = if ($Test) { 'test --workspace' } else { 'build' }
$releaseFlag = if ($Release) { '--release' } else { '' }
$line = 'call "{0}" -arch=x64 -host_arch=x64 >nul && cargo {1} --manifest-path "{2}" {3}' -f $developer, $action, $manifest, $releaseFlag
& $env:ComSpec /d /s /c $line
if ($LASTEXITCODE -ne 0) { throw "Native shell build/test failed with exit code $LASTEXITCODE." }
