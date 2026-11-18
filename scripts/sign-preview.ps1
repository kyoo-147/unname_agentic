param(
    [Parameter(Mandatory = $true)][string]$Exe,
    [string]$Pfx = 'artifacts\mirror-preview.pfx',
    [string]$Password = 'mirror-preview',
    [switch]$Create
)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $Exe -PathType Leaf)) { throw "Executable not found: $Exe" }
$signtool = Get-ChildItem 'C:\Program Files (x86)\Windows Kits\10\bin' -Recurse -Filter signtool.exe -ErrorAction SilentlyContinue | Where-Object FullName -like '*x64*' | Sort-Object FullName -Descending | Select-Object -First 1
if (-not $signtool) { throw 'signtool.exe not found in the Windows SDK.' }
if ($Create -or -not (Test-Path -LiteralPath $Pfx)) {
    $cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject 'CN=Mirror PDF Preview (self-signed), O=Mirror PDF' -CertStoreLocation 'Cert:\CurrentUser\My' -NotAfter (Get-Date).AddYears(2) -KeyUsage DigitalSignature
    $secure = ConvertTo-SecureString -String $Password -Force -AsPlainText
    $directory = Split-Path -Parent $Pfx
    if ($directory -and -not (Test-Path -LiteralPath $directory)) { [void](New-Item -ItemType Directory -Path $directory) }
    Export-PfxCertificate -Cert $cert -FilePath $Pfx -Password $secure | Out-Null
    Write-Output ("CERT_THUMBPRINT={0}" -f $cert.Thumbprint)
}
& $signtool.FullName sign /fd SHA256 /f $Pfx /p $Password /t http://timestamp.digicert.com $Exe
if ($LASTEXITCODE -ne 0) {
    Write-Output 'TIMESTAMP_FAILED_RETRY_WITHOUT'
    & $signtool.FullName sign /fd SHA256 /f $Pfx /p $Password $Exe
    if ($LASTEXITCODE -ne 0) { throw 'signtool sign failed.' }
}
$signature = Get-AuthenticodeSignature -LiteralPath $Exe
Write-Output ("SIGN_STATUS={0}" -f $signature.Status)
Write-Output ("SIGNER={0}" -f $signature.SignerCertificate.Subject)
Write-Output ("SIGN_SHA256={0}" -f (Get-FileHash -LiteralPath $Exe -Algorithm SHA256).Hash)
