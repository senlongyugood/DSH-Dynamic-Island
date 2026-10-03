<#
.SYNOPSIS
  Adds or removes a Windows Startup shortcut for the Dynamic Island overlay.

.DESCRIPTION
  Creates a .lnk in the current user's Startup folder pointing at
  DynamicIsland.exe with a log path beside it, so the island comes up with the
  desktop session. -Remove deletes it again.

.PARAMETER Remove
  Delete the startup shortcut instead of creating it.

.PARAMETER Arguments
  Extra arguments for the shortcut; defaults to the same set start-island.cmd uses
  (`--always-show --hide-on-disconnect --report <overlay>\island.state.txt --log <overlay>\island.log`).

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\setup-autostart.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File .\setup-autostart.ps1 -Remove
#>
[CmdletBinding()]
param(
  [switch]$Remove,
  [string]$Arguments
)

$ErrorActionPreference = 'Stop'
$overlayDir = $PSScriptRoot
$exe = Join-Path $overlayDir 'DynamicIsland.exe'
$startup = [Environment]::GetFolderPath('Startup')
$link = Join-Path $startup 'DSH Dynamic Island.lnk'

if ($Remove) {
  if (Test-Path -LiteralPath $link) {
    Remove-Item -LiteralPath $link -Force
    Write-Host "Removed startup shortcut: $link" -ForegroundColor Green
  } else {
    Write-Host 'No startup shortcut to remove.' -ForegroundColor Yellow
  }
  return
}

if (-not (Test-Path -LiteralPath $exe)) { throw "missing $exe — run build.ps1 first" }
if (-not $Arguments) {
  $Arguments = "--always-show --hide-on-disconnect --report `"$(Join-Path $overlayDir 'island.state.txt')`" --log `"$(Join-Path $overlayDir 'island.log')`""
}

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($link)
$shortcut.TargetPath = $exe
$shortcut.Arguments = $Arguments
$shortcut.WorkingDirectory = $overlayDir
$shortcut.Description = 'DeepSeek Harness task island (top-center status pill)'
$shortcut.Save()

Write-Host 'Dynamic Island will start with Windows.' -ForegroundColor Green
Write-Host "  shortcut : $link"
Write-Host '  remove   : powershell -NoProfile -ExecutionPolicy Bypass -File .\setup-autostart.ps1 -Remove'
