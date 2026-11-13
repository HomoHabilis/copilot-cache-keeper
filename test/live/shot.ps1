# Screenshot of one window (by part of its title) into a PNG. Used by preview.sh.
param([string]$Title = "Extension Development Host", [string]$Out = "shot.png", [switch]$Front)
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System; using System.Runtime.InteropServices;
public class CkWin {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, UIntPtr e);
  public struct RECT { public int L, T, R, B; }
}
"@
[CkWin]::SetProcessDPIAware() | Out-Null
$p = Get-Process | Where-Object { $_.MainWindowTitle -like "*$Title*" } | Select-Object -First 1
if (-not $p) { Write-Output "NOWINDOW"; exit 1 }
# to the front (a status-bar hover only shows in the focused window, and a covered window can't be
# photographed). Windows lets a background process do that only right after a key event: a bare Alt.
# (Not for a hover's own screenshot: the key would close it.)
if ($Front) {
  [CkWin]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero); [CkWin]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
  [CkWin]::SetForegroundWindow($p.MainWindowHandle) | Out-Null
  Start-Sleep -Milliseconds 250
}
$r = New-Object CkWin+RECT
[CkWin]::GetWindowRect($p.MainWindowHandle, [ref]$r) | Out-Null
$w = $r.R - $r.L; $h = $r.B - $r.T
if ($w -le 0 -or $h -le 0) { Write-Output "MINIMIZED"; exit 1 }
$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($r.L, $r.T, 0, 0, $bmp.Size)
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
Write-Output "OK $w x $h"
