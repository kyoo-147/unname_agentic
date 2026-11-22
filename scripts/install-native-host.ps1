[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [ValidateSet('Register', 'Unregister', 'Verify')]
    [string]$Action = 'Register',
    [string]$ExtensionId,
    [string]$HostPath,
    [switch]$DryRun,
    [switch]$Diagnostics
)

$ErrorActionPreference = 'Stop'
$hostName = 'com.pdfworkspace.bridge'
$registryKey = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName"
$hostFileName = 'pdf-workspace-host.exe'

function Get-InstallPaths {
    if ($env:OS -ne 'Windows_NT') { throw 'Native host registration supports Windows Chrome only.' }
    if (-not $env:LOCALAPPDATA -or -not [IO.Path]::IsPathRooted($env:LOCALAPPDATA) -or $env:LOCALAPPDATA.StartsWith('\\')) {
        throw 'LOCALAPPDATA must be an absolute local path.'
    }
    $directory = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'PdfWorkspace\native-messaging'))
    return [pscustomobject]@{ Directory = $directory; Manifest = Join-Path $directory "$hostName.json" }
}

function Test-NoReparsePoints([string[]]$Paths) {
    foreach ($path in $Paths) {
        $ancestor = [IO.Path]::GetFullPath($path)
        while ($ancestor) {
            if (Test-Path -LiteralPath $ancestor) {
                $item = Get-Item -LiteralPath $ancestor -Force
                if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Refusing a symlink or junction in installation path: $ancestor" }
            }
            $parent = Split-Path -Path $ancestor -Parent
            if ($parent -eq $ancestor) { break }
            $ancestor = $parent
        }
    }
}

function Get-ExpectedManifest {
    if ([string]::IsNullOrWhiteSpace($ExtensionId) -or $ExtensionId -cnotmatch '^[a-p]{32}$') {
        throw 'ExtensionId must be exactly 32 lowercase Chrome extension ID characters (a through p).'
    }
    if ([string]::IsNullOrWhiteSpace($HostPath) -or -not [IO.Path]::IsPathRooted($HostPath) -or $HostPath.StartsWith('\\')) {
        throw 'HostPath must be an absolute local executable path, not a UNC path.'
    }
    $executable = [IO.Path]::GetFullPath((Resolve-Path -LiteralPath $HostPath).ProviderPath)
    if ([IO.Path]::GetFileName($executable) -cne $hostFileName -or (Get-Item -LiteralPath $executable).PSIsContainer) {
        throw "HostPath must point to the built $hostFileName."
    }
    return [ordered]@{
        name = $hostName
        description = 'PDF Workspace opt-in local PDF inbox bridge'
        path = $executable
        type = 'stdio'
        allowed_origins = @("chrome-extension://$ExtensionId/")
    }
}

function Get-RegisteredManifest([string]$ManifestPath) {
    if (-not (Test-Path -LiteralPath $registryKey)) { return $null }
    $registered = [string](Get-Item -LiteralPath $registryKey).GetValue('')
    if ([string]::IsNullOrWhiteSpace($registered)) { throw "Registry entry exists but has no manifest path: $registryKey" }
    if ([IO.Path]::GetFullPath($registered) -ine [IO.Path]::GetFullPath($ManifestPath)) {
        throw "Native host collision: $registryKey points to '$registered', not this install's '$ManifestPath'. Refusing to overwrite or remove it."
    }
    return $registered
}

function Test-HostReady([string]$Executable, [string]$Origin) {
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $Executable
    $start.Arguments = $Origin
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $start
    try {
        if (-not $process.Start()) { throw 'Native host process did not start.' }
        $body = [Text.Encoding]::UTF8.GetBytes('{"type":"hello"}')
        $frame = [byte[]]::new(4 + $body.Length)
        [Array]::Copy([BitConverter]::GetBytes([uint32]$body.Length), $frame, 4)
        [Array]::Copy($body, 0, $frame, 4, $body.Length)
        $process.StandardInput.BaseStream.Write($frame, 0, $frame.Length)
        $process.StandardInput.Close()
        if (-not $process.WaitForExit(5000)) { $process.Kill(); throw 'Native host readiness handshake timed out after 5 seconds.' }
        $response = $process.StandardOutput.BaseStream
        $length = [byte[]]::new(4)
        if ($response.Read($length, 0, 4) -ne 4) { throw 'Native host returned no readiness frame.' }
        $size = [BitConverter]::ToUInt32($length, 0)
        if ($size -eq 0 -or $size -gt 65536) { throw "Native host returned invalid readiness frame length: $size" }
        $payload = [byte[]]::new([int]$size)
        $offset = 0
        while ($offset -lt $payload.Length) {
            $count = $response.Read($payload, $offset, $payload.Length - $offset)
            if ($count -eq 0) { throw 'Native host readiness frame was truncated.' }
            $offset += $count
        }
        $reply = [Text.Encoding]::UTF8.GetString($payload) | ConvertFrom-Json
        if ($reply.ok -ne $true -or $reply.status -ne 'ready' -or $reply.protocol -ne 1) { throw 'Native host hello response did not report protocol 1 readiness.' }
        Write-Output 'HOST_READINESS=pass (protocol=1, hello=ready)'
    } finally { $process.Dispose() }
}

$paths = Get-InstallPaths
if ($Action -eq 'Unregister') {
    $existing = Get-RegisteredManifest $paths.Manifest
    if (-not $existing) { Write-Output 'REGISTRATION=absent'; exit 0 }
    if ($DryRun) { Write-Output "DRY_RUN=would remove only $registryKey; manifest retained at $existing"; exit 0 }
    if ($PSCmdlet.ShouldProcess($registryKey, 'Remove this current-user native-host registration only')) {
        Remove-Item -LiteralPath $registryKey -Force
        Write-Output "REGISTRATION=removed; manifest retained at $existing"
    }
    exit 0
}

if ($Action -eq 'Verify') {
    if (-not (Test-Path -LiteralPath $paths.Manifest -PathType Leaf)) { throw "Native host manifest is missing: $($paths.Manifest)" }
    $manifest = Get-Content -LiteralPath $paths.Manifest -Raw | ConvertFrom-Json
    if ($manifest.name -cne $hostName -or $manifest.type -cne 'stdio' -or @($manifest.allowed_origins).Count -ne 1 -or [string]$manifest.allowed_origins[0] -cnotmatch '^chrome-extension://[a-p]{32}/$') { throw 'Native host manifest identity or allowlist is invalid.' }
    if ($ExtensionId -and $manifest.allowed_origins[0] -cne "chrome-extension://$ExtensionId/") { throw 'Registered extension ID does not match the requested ExtensionId.' }
    $registered = Get-RegisteredManifest $paths.Manifest
    if (-not $registered) { throw "Native host registration is absent: $registryKey" }
    $executable = [string]$manifest.path
    if (-not [IO.Path]::IsPathRooted($executable) -or [IO.Path]::GetFileName($executable) -cne $hostFileName -or -not (Test-Path -LiteralPath $executable -PathType Leaf)) { throw "Registered native host executable is missing or invalid: $executable" }
    Test-NoReparsePoints @($paths.Manifest, $executable)
    Write-Output "REGISTRATION=verified ($registryKey)"
    Write-Output "MANIFEST=$($paths.Manifest)"
    Write-Output "HOST=$executable"
    if ($Diagnostics) { Test-HostReady $executable ([string]$manifest.allowed_origins[0]) }
    exit 0
}

$expected = Get-ExpectedManifest
$executable = [string]$expected.path
Test-NoReparsePoints @($executable, $paths.Manifest)
$existing = Get-RegisteredManifest $paths.Manifest
if (Test-Path -LiteralPath $paths.Manifest -PathType Leaf) {
    $prior = Get-Content -LiteralPath $paths.Manifest -Raw | ConvertFrom-Json
    if ($prior.name -cne $hostName) { throw "Manifest collision: refusing to replace unrelated manifest $($paths.Manifest)" }
}
if ($DryRun) {
    Write-Output "DRY_RUN=would generate manifest for chrome-extension://$ExtensionId/ and register only $registryKey"
    if ($Diagnostics) { Test-HostReady $executable ([string]$expected.allowed_origins[0]) }
    exit 0
}
if ($PSCmdlet.ShouldProcess("$($paths.Manifest) and $registryKey", "Register native host for only extension $ExtensionId")) {
    [IO.Directory]::CreateDirectory($paths.Directory) | Out-Null
    $temporary = Join-Path $paths.Directory "$hostName.$([guid]::NewGuid().ToString('N')).tmp"
    try {
        [IO.File]::WriteAllText($temporary, ($expected | ConvertTo-Json -Depth 4), [Text.UTF8Encoding]::new($false))
        Move-Item -LiteralPath $temporary -Destination $paths.Manifest -Force
        if (-not (Test-Path -LiteralPath $registryKey)) { New-Item -Path $registryKey | Out-Null }
        Set-Item -LiteralPath $registryKey -Value $paths.Manifest
    } finally { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary } }
    Write-Output "REGISTRATION=written for chrome-extension://$ExtensionId/ in this user's Chrome only."
    Write-Output 'No machine-wide registry keys changed; unregistering retains the manifest file.'
    if ($Diagnostics) { Test-HostReady $executable ([string]$expected.allowed_origins[0]) }
}
