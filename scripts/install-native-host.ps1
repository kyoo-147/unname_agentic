[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory = $true)]
    [string]$ExtensionId,
    [Parameter(Mandatory = $true)]
    [string]$HostPath
)

$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'This installer supports Windows Chrome only.' }
if ($ExtensionId -cnotmatch '^[a-p]{32}$') { throw 'ExtensionId must be exactly 32 lowercase Chrome extension ID characters (a through p).' }
if (-not [IO.Path]::IsPathRooted($HostPath) -or $HostPath.StartsWith('\\')) { throw 'HostPath must be an absolute local executable path, not a UNC path.' }
$executable = (Resolve-Path -LiteralPath $HostPath).ProviderPath
if ([IO.Path]::GetFileName($executable) -cne 'pdf-workspace-host.exe' -or (Get-Item -LiteralPath $executable).PSIsContainer) { throw 'HostPath must point to the built pdf-workspace-host.exe.' }
if (-not $env:LOCALAPPDATA -or -not [IO.Path]::IsPathRooted($env:LOCALAPPDATA) -or $env:LOCALAPPDATA.StartsWith('\\')) { throw 'LOCALAPPDATA must be an absolute local path.' }

$hostName = 'com.pdfworkspace.bridge'
$directory = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'PdfWorkspace\native-messaging'))
$manifestPath = Join-Path $directory "$hostName.json"
$registryKey = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName"
foreach ($leaf in @($executable, $manifestPath)) {
    $ancestor = $leaf
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
$manifest = [ordered]@{
    name = $hostName
    description = 'PDF Workspace opt-in local PDF inbox bridge'
    path = $executable
    type = 'stdio'
    allowed_origins = @("chrome-extension://$ExtensionId/")
}
if ($PSCmdlet.ShouldProcess("$manifestPath and $registryKey", "Register native host for only extension $ExtensionId")) {
    [IO.Directory]::CreateDirectory($directory) | Out-Null
    $temporary = Join-Path $directory "$hostName.$([guid]::NewGuid().ToString('N')).tmp"
    try {
        [IO.File]::WriteAllText($temporary, ($manifest | ConvertTo-Json -Depth 4), [Text.UTF8Encoding]::new($false))
        Move-Item -LiteralPath $temporary -Destination $manifestPath -Force
        New-Item -Path $registryKey -Force | Out-Null
        Set-Item -LiteralPath $registryKey -Value $manifestPath
    } finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary }
    }
    Write-Output "Registered $hostName for chrome-extension://$ExtensionId/ in this user's Chrome only."
    Write-Output 'No PDFs were opened, no providers were contacted, and no machine-wide registry keys were changed.'
}
