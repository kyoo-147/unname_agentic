param(
    [Parameter(Mandatory = $true)][ValidateSet('capture','close')][string]$Action,
    [int]$ProcessId = 0,
    [string]$Out = '',
    [int]$TimeoutSec = 25
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
if (-not ('MirrorCapture' -as [type])) {
    Add-Type @"
using System;
using System.Runtime.InteropServices;
public class MirrorCapture {
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
}
"@
}
function Get-MainWindow([int]$procId) {
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    do {
        $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
        if (-not $p) { throw "Process $procId exited before showing a window." }
        if ($p.MainWindowHandle -ne [IntPtr]::Zero) { return $p.MainWindowHandle }
        Start-Sleep -Milliseconds 250
    } while ((Get-Date) -lt $deadline)
    throw "No main window for process $procId within $TimeoutSec s."
}
if ($Action -eq 'capture') {
    $hwnd = Get-MainWindow $ProcessId
    $rect = New-Object MirrorCapture+RECT
    [void][MirrorCapture]::GetWindowRect($hwnd, [ref]$rect)
    $w = $rect.Right - $rect.Left; $h = $rect.Bottom - $rect.Top
    if ($w -le 0 -or $h -le 0) { throw "Bad window rect $w x $h." }
    $bmp = New-Object System.Drawing.Bitmap($w, $h)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $hdc = $g.GetHdc()
    $ok = [MirrorCapture]::PrintWindow($hwnd, $hdc, 2)
    $g.ReleaseHdc($hdc); $g.Dispose()
    if (-not $ok) { $bmp.Dispose(); throw 'PrintWindow returned no frame.' }
    $dir = Split-Path -Parent $Out
    if ($dir -and -not (Test-Path -LiteralPath $dir)) { [void](New-Item -ItemType Directory -Path $dir) }
    $bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
    Write-Output ("CAPTURE={0} SIZE={1}x{2}" -f $Out, $w, $h)
} else {
    $p = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if (-not $p) { Write-Output 'CLOSED=already' }
    else {
        [void]$p.CloseMainWindow()
        $p | Wait-Process -Timeout 8 -ErrorAction SilentlyContinue
        if (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue) { Stop-Process -Id $ProcessId -Force; Write-Output 'CLOSED=forced' }
        else { Write-Output 'CLOSED=clean' }
    }
}
