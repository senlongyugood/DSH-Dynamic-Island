<#
.SYNOPSIS
  A stand-in "harness" window for the overlay's focus test.

.DESCRIPTION
  `overlay-live-test.ps1` must prove that clicking a task brings the harness window to the
  foreground, but doing that against the real DeepSeek Harness window would steal the user's
  focus and switch their session. This script shows a plain window whose title the overlay is
  pointed at (`--process "<Title>"`), so the assertion stays hermetic and harmless.

.PARAMETER Title
  Window title the overlay matches on. Default "Harness Stub Target".

.PARAMETER Seconds
  How long to stay on screen; 0 (default) waits until the process is killed.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\harness-stub.ps1 -Seconds 30
#>
[CmdletBinding()]
param(
  [string]$Title = 'Harness Stub Target',
  [int]$Seconds = 0
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class StubWin32 {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int command);
}
'@

$form = New-Object System.Windows.Forms.Form
$form.Text = $Title
$form.Width = 420
$form.Height = 300
$form.StartPosition = 'CenterScreen'
$form.TopMost = $false
$form.BackColor = [System.Drawing.Color]::FromArgb(28, 30, 36)

$label = New-Object System.Windows.Forms.Label
$label.Text = "stand-in harness window`n(used by overlay-live-test.ps1)"
$label.ForeColor = [System.Drawing.Color]::Gainsboro
$label.AutoSize = $true
$label.Location = New-Object System.Drawing.Point(16, 16)
$form.Controls.Add($label)

if ($Seconds -gt 0) {
  $timer = New-Object System.Windows.Forms.Timer
  $timer.Interval = $Seconds * 1000
  $timer.Add_Tick({ $form.Close() })
  $timer.Start()
}

# A hidden console start (STARTF_USESHOWWINDOW) is inherited by the first window this process
# creates, which would leave the form invisible; showing it explicitly keeps the console hidden
# while the window the overlay must find stays on screen.
$form.Add_Shown({ [void][StubWin32]::ShowWindow($form.Handle, 5) })

[void]$form.ShowDialog()
$form.Dispose()
