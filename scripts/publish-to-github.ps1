<#
.SYNOPSIS
Publish the product code to the public repository: source only, no analysis.

.DESCRIPTION
The public repository gets the product: the native GPUI app, the browser
extension, the native messaging host and the build scripts. Analysis,
planning, proofs, captures and personal notes stay here.

Every path is an allowlist entry; anything not named below is never copied.

.PARAMETER Destination
The checkout of the public repository.

.PARAMETER DryRun
List what would be copied, change nothing.
#>
[CmdletBinding()]
param(
    [string]$Destination = 'D:\work\unname_agentic',
    [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path -LiteralPath (Join-Path $Destination '.git'))) { throw "Not a git checkout: $Destination" }

# Product files: (source relative to this repo, everything under it except the listed exclusions)
$product = @(
    @{ Path = 'src';                    Exclude = @() }
    @{ Path = 'extension';              Exclude = @() }
    @{ Path = 'tests';                  Exclude = @() }
    @{ Path = 'public';                 Exclude = @() }
    @{ Path = 'native-shell\src';       Exclude = @() }
    @{ Path = 'native-shell\assets';    Exclude = @() }
    @{ Path = 'native-shell\assets-safe'; Exclude = @() }
    @{ Path = 'native-shell\crates';    Exclude = @() }
    @{ Path = 'native-shell\vendor';    Exclude = @() }
    @{ Path = 'desktop\src';            Exclude = @() }
    @{ Path = 'desktop\tests';          Exclude = @() }
    @{ Path = 'scripts';                Exclude = @('native-*.txt') }
)
# Single files: build configuration and licences.
$files = @(
    'package.json', 'pnpm-lock.yaml', 'tsconfig.json', 'vite.config.ts', 'vitest.config.ts',
    'playwright.config.ts', 'index.html', 'rust-toolchain.toml',
    'native-shell\Cargo.toml', 'native-shell\Cargo.lock', 'native-shell\build.rs',
    'native-shell\rust-toolchain.toml', 'native-shell\LICENSE', 'native-shell\THIRD_PARTY.md',
    'native-shell\.gitattributes', 'desktop\Cargo.toml', 'desktop\Cargo.lock'
)

$copied = 0
$bytes = 0
foreach ($entry in $product) {
    $from = Join-Path $root $entry.Path
    if (-not (Test-Path -LiteralPath $from)) { throw "Missing product path: $from" }
    $to = Join-Path $Destination $entry.Path
    if ($DryRun) {
        $count = (Get-ChildItem -LiteralPath $from -Recurse -File |
            Where-Object { $name = $_.Name; -not ($entry.Exclude | Where-Object { $name -like $_ }) }).Count
        Write-Output ("would copy {0,-24} {1,4} files" -f $entry.Path, $count)
        continue
    }
    if (Test-Path -LiteralPath $to) { Remove-Item -LiteralPath $to -Recurse -Force }
    New-Item -ItemType Directory -Path $to -Force | Out-Null
    $robocopy = @($from, $to, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/R:0', '/W:0')
    foreach ($pattern in $entry.Exclude) { $robocopy += @('/XF', $pattern) }
    & robocopy @robocopy | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy failed for $($entry.Path) with $LASTEXITCODE" }
    $s = Get-ChildItem -LiteralPath $to -Recurse -File | Measure-Object Length -Sum
    $copied += $s.Count
    $bytes += $s.Sum
}
foreach ($file in $files) {
    $from = Join-Path $root $file
    if (-not (Test-Path -LiteralPath $from)) { throw "Missing product file: $from" }
    if ($DryRun) { Write-Output ("would copy {0}" -f $file); continue }
    $to = Join-Path $Destination $file
    $dir = Split-Path -Parent $to
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    Copy-Item -LiteralPath $from -Destination $to -Force
    $copied++
    $bytes += (Get-Item -LiteralPath $to).Length
}
if (-not $DryRun) { Write-Output ("published {0} files, {1:N2} MB into {2}" -f $copied, ($bytes / 1MB), $Destination) }
