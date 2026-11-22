# Pre-push gate: the same checks the GitHub workflow would run, executed locally.
#
# GitHub Actions cannot start for this account (billing lock), so the gate runs
# here instead: a push that fails these checks is refused. Install once with
# `powershell -NoProfile -File scripts/install-hooks.ps1`.
#
# Native output is redirected to files, not piped through Out-String. This avoids
# PowerShell 5.1 allocating the complete test transcript in memory and makes an
# output-capture exception a blocking result rather than an accidental pass.
param([switch]$Quick)
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
$maxCaptureBytes = 512KB
$failed = New-Object System.Collections.Generic.List[string]

function Add-Failure([string]$label) {
  if (-not $script:failed.Contains($label)) { $script:failed.Add($label) }
}

function Read-BoundedText([string]$path) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return '' }
  $length = (Get-Item -LiteralPath $path).Length
  if ($length -le $script:maxCaptureBytes) {
    return [IO.File]::ReadAllText($path)
  }

  $headBytes = [Math]::Min(64KB, [int]$length)
  $tailBytes = [Math]::Min(448KB, [int]($length - $headBytes))
  $stream = [IO.File]::OpenRead($path)
  try {
    $head = New-Object byte[] $headBytes
    [void]$stream.Read($head, 0, $head.Length)
    [void]$stream.Seek(-$tailBytes, [IO.SeekOrigin]::End)
    $tail = New-Object byte[] $tailBytes
    [void]$stream.Read($tail, 0, $tail.Length)
    return '[output truncated to a bounded diagnostic excerpt]' + [Environment]::NewLine +
      [Text.Encoding]::UTF8.GetString($head) + [Environment]::NewLine +
      '[... tail ...]' + [Environment]::NewLine +
      [Text.Encoding]::UTF8.GetString($tail)
  } finally {
    $stream.Dispose()
  }
}

function Write-FailureArtifact([string]$label, [string]$reason, [string]$stdout, [string]$stderr) {
  $artifact = Join-Path ([IO.Path]::GetTempPath()) ('mirror-pre-push-' + [Guid]::NewGuid().ToString('N') + '.log')
  $content = @(
    "pre-push step: $label"
    "reason: $reason"
    ''
    '--- stdout ---'
    $stdout
    '--- stderr ---'
    $stderr
  ) -join [Environment]::NewLine
  try {
    [IO.File]::WriteAllText($artifact, $content)
    return $artifact
  } catch {
    Write-Host "[pre-push] could not preserve output artifact: $($_.Exception.Message)" -ForegroundColor Red
    return $null
  }
}

function Step([string]$label, [scriptblock]$action) {
  Write-Host "[pre-push] $label"
  $stdoutPath = Join-Path ([IO.Path]::GetTempPath()) ('mirror-pre-push-' + [Guid]::NewGuid().ToString('N') + '.stdout')
  $stderrPath = Join-Path ([IO.Path]::GetTempPath()) ('mirror-pre-push-' + [Guid]::NewGuid().ToString('N') + '.stderr')
  $exitCode = 1
  $captureError = $null
  $stdout = ''
  $stderr = ''

  try {
    & $action 1> $stdoutPath 2> $stderrPath
    if ($null -eq $LASTEXITCODE) {
      $captureError = 'native process exit code was not available'
    } else {
      $exitCode = [int]$LASTEXITCODE
    }
  } catch {
    $captureError = $_.Exception.ToString()
  }

  try {
    $stdout = Read-BoundedText $stdoutPath
    $stderr = Read-BoundedText $stderrPath
  } catch {
    $captureError = if ($captureError) {
      "$captureError; output read failed: $($_.Exception.Message)"
    } else {
      "output read failed: $($_.Exception.Message)"
    }
  }

  $artifact = $null
  if ($captureError) {
    Add-Failure $label
    $artifact = Write-FailureArtifact $label $captureError $stdout $stderr
    Write-Host "[pre-push] BLOCKED: $label output capture failed: $captureError" -ForegroundColor Red
    if ($artifact) { Write-Host "[pre-push] diagnostic artifact: $artifact" }
  } elseif ($exitCode -ne 0) {
    Add-Failure $label
    $artifact = Write-FailureArtifact $label "native process exited $exitCode" $stdout $stderr
    Write-Host "[pre-push] BLOCKED: $label exited $exitCode" -ForegroundColor Red
    if ($artifact) { Write-Host "[pre-push] diagnostic artifact: $artifact" }
  }

  Remove-Item -LiteralPath $stdoutPath, $stderrPath -Force -ErrorAction SilentlyContinue
  return [pscustomobject]@{
    Label = $label
    ExitCode = $exitCode
    CaptureError = $captureError
    Stdout = $stdout
    Stderr = $stderr
    Artifact = $artifact
  }
}

function Get-TestSummary([string]$text) {
  $line = ($text -split "`r?`n" | Where-Object { $_ -match '^\s*Tests\s+\d' } | Select-Object -Last 1)
  if (-not $line) { return $null }
  $passed = [regex]::Match($line, '(?<count>\d+)\s+passed\b')
  $failed = [regex]::Match($line, '(?<count>\d+)\s+failed\b')
  return [pscustomobject]@{
    Line = $line.Trim()
    Passed = if ($passed.Success) { [int]$passed.Groups['count'].Value } else { $null }
    Failed = if ($failed.Success) { [int]$failed.Groups['count'].Value } else { 0 }
  }
}

Push-Location $root
try {
  Step 'typecheck' { pnpm typecheck } | Out-Null

  $testResult = Step 'pnpm test' { pnpm test }
  $testText = "$($testResult.Stdout)`n$($testResult.Stderr)"
  $testSummary = Get-TestSummary $testText
  if ($testSummary) {
    Write-Host ("[pre-push] " + $testSummary.Line)
  } else {
    Add-Failure 'pnpm test summary'
    $artifact = Write-FailureArtifact 'pnpm test summary' 'missing or empty Vitest summary' $testResult.Stdout $testResult.Stderr
    Write-Host '[pre-push] BLOCKED: pnpm test produced no readable summary' -ForegroundColor Red
    if ($artifact) { Write-Host "[pre-push] diagnostic artifact: $artifact" }
  }
  if ($testSummary -and $testSummary.Passed -lt 1) {
    Add-Failure 'pnpm test summary'
    Write-Host '[pre-push] BLOCKED: pnpm test summary recorded no passing tests' -ForegroundColor Red
  }
  if ($testSummary -and $testSummary.Failed -gt 0) {
    Add-Failure 'pnpm test summary'
    Write-Host '[pre-push] BLOCKED: pnpm test summary recorded failed tests' -ForegroundColor Red
  }

  Step 'committed imports' { node scripts/check-committed-imports.mjs } | Out-Null
  if (-not $Quick) { Step 'build' { pnpm build } | Out-Null }
} finally {
  Pop-Location
}

if ($failed.Count -gt 0) {
  Write-Host ''
  Write-Host ("[pre-push] BLOCKED: " + ($failed -join ', ')) -ForegroundColor Red
  exit 1
}
Write-Host '[pre-push] all gates passed'
exit 0
