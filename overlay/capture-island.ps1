<#
.SYNOPSIS
  Captures the island window (plus a margin) to a PNG and reports the pixel colour
  at its corners and centre, so appearance claims can be checked instead of guessed.

.DESCRIPTION
  Finds the top-level window titled "DSH Dynamic Island", grabs that rectangle plus
  a margin from the screen, writes the PNG, and prints the corner/edge/centre pixels.
  Corners outside the rounded shape must match the desktop behind (not a uniform
  grey block); the centre must be the dark pill.

.PARAMETER Margin
  Pixels of surrounding screen to include, so the corners are visible. Default 18.

.PARAMETER Hover
  Move the pointer onto the island first (and back afterwards), so the expanded card
  is captured instead of the collapsed pill.

.PARAMETER Out
  PNG path to write. Defaults to the overlay directory.

.PARAMETER Report
  The overlay's `--report` status file. When given, the pill's own bounds come from it so the
  capture crops to the island (the window is larger than the pill by design).

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\capture-island.ps1 -Hover -Report .\island.state
#>
[CmdletBinding()]
param(
  [int]$Margin = 18,
  [string]$Out,
  [switch]$Hover,
  [string]$Report
)

$ErrorActionPreference = 'Stop'
if (-not $Out) { $Out = Join-Path $PSScriptRoot 'island-capture.png' }
Add-Type -AssemblyName System.Drawing

# A DPI-unaware process gets virtualized screen coordinates, so the window rect and
# CopyFromScreen would disagree on a scaled display and capture the wrong region.
Add-Type @'
using System.Runtime.InteropServices;
public static class DpiAware {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
}
'@
[void][DpiAware]::SetProcessDPIAware()

Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class Cap {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int max);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }

  /** Screen rect of the visible island window, or null. */
  public static int[] IslandRect(string title) {
    int[] found = null;
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      var text = new StringBuilder(256);
      GetWindowText(h, text, text.Capacity);
      if (text.ToString() != title) return true;
      RECT rect; GetWindowRect(h, out rect);
      found = new[] { rect.Left, rect.Top, rect.Right - rect.Left, rect.Bottom - rect.Top };
      return false;
    }, IntPtr.Zero);
    return found;
  }
}
'@

function Get-IslandRect { return [Cap]::IslandRect('DSH Dynamic Island') }

# The window keeps the island's largest footprint, so the pill sits at its top centre; the
# report (when given) tells us the pill's own size for hovering and cropping.
function Get-ReportedPill([string]$path) {
  if (-not $path -or -not (Test-Path -LiteralPath $path)) { return $null }
  $values = @{}
  foreach ($line in Get-Content -LiteralPath $path) {
    if ($line -match '^(pillWidth|pillHeight|windowSize):\s*(.+)$') { $values[$Matches[1]] = $Matches[2].Trim() }
  }
  if (-not $values.ContainsKey('pillWidth') -or -not $values.ContainsKey('windowSize')) { return $null }
  $windowWidth = [double](($values.windowSize -split 'x')[0])
  if ($windowWidth -le 0) { return $null }
  return [pscustomobject]@{
    Width       = [double]$values.pillWidth
    Height      = [double]$values.pillHeight
    WindowWidth = $windowWidth
  }
}

$origin = New-Object DpiAware+POINT
[void][DpiAware]::GetCursorPos([ref]$origin)

$rect = Get-IslandRect
if (-not $rect) { throw 'capture: no visible island window found (is it running and showing a task?)' }
Write-Host ("window  : x={0} y={1} {2}x{3}" -f $rect[0], $rect[1], $rect[2], $rect[3])

if ($Hover) {
  # Park the pointer on the pill — its top strip, not the window centre, because the rest of
  # the window is transparent — then wait for the morph to settle: the first frames are
  # mid-animation. The jiggle guarantees a WM_MOUSEMOVE even if the pointer is already there.
  $centreX = $rect[0] + [int]($rect[2] / 2)
  $centreY = $rect[1] + 12
  [void][DpiAware]::SetCursorPos($centreX - 8, $centreY)
  Start-Sleep -Milliseconds 150
  [void][DpiAware]::SetCursorPos($centreX, $centreY)
  Start-Sleep -Milliseconds 900
}

$pill = Get-ReportedPill $Report
if ($pill) {
  # Crop to the pill (top centre of the window), converting layout units to device pixels.
  $scale = $rect[2] / $pill.WindowWidth
  $cropWidth = [int]($pill.Width * $scale)
  $cropHeight = [int]($pill.Height * $scale)
  $left = [Math]::Max(0, $rect[0] + [int](($rect[2] - $cropWidth) / 2) - $Margin)
  $top = [Math]::Max(0, $rect[1] - $Margin)
  $width = $cropWidth + ($Margin * 2)
  $height = $cropHeight + ($Margin * 2)
} else {
  # No report: capture the window's top strip, which is where the island lives.
  $stripHeight = if ($Hover) { $rect[3] } else { [Math]::Min($rect[3], 60) }
  $left = [Math]::Max(0, $rect[0] - $Margin)
  $top = [Math]::Max(0, $rect[1] - $Margin)
  $width = $rect[2] + ($Margin * 2)
  $height = $stripHeight + ($Margin * 2)
}

$bitmap = New-Object System.Drawing.Bitmap $width, $height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($left, $top, 0, 0, (New-Object System.Drawing.Size $width, $height))
$graphics.Dispose()
$bitmap.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)

function Hex([int]$x, [int]$y) {
  $pixel = $bitmap.GetPixel($x, $y)
  return ('#{0:X2}{1:X2}{2:X2}' -f $pixel.R, $pixel.G, $pixel.B)
}

$innerLeft = $Margin
$innerTop = $Margin
$innerRight = $Margin + $rect[2] - 1
$innerBottom = $Margin + $rect[3] - 1
$centreX = [int]($width / 2)
$centreY = [int]($height / 2)

Write-Host ("captured: {0} ({1}x{2}, margin {3})" -f $Out, $width, $height, $Margin) -ForegroundColor Green
Write-Host ("corners (outside the rounded shape; must match the desktop, not a grey block):")
Write-Host ("  top-left     ({0},{1}) = {2}" -f $innerLeft, $innerTop, (Hex $innerLeft $innerTop))
Write-Host ("  top-right    ({0},{1}) = {2}" -f $innerRight, $innerTop, (Hex $innerRight $innerTop))
Write-Host ("  bottom-left  ({0},{1}) = {2}" -f $innerLeft, $innerBottom, (Hex $innerLeft $innerBottom))
Write-Host ("  bottom-right ({0},{1}) = {2}" -f $innerRight, $innerBottom, (Hex $innerRight $innerBottom))
Write-Host ("centre       ({0},{1}) = {2}" -f $centreX, $centreY, (Hex $centreX $centreY))
Write-Host ("just outside the window, above: {0}" -f (Hex $centreX ([Math]::Max(0, $Margin - 6))))
$bitmap.Dispose()

if ($Hover) { [void][DpiAware]::SetCursorPos($origin.X, $origin.Y) }
