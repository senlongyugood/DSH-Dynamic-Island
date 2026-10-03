<#
.SYNOPSIS
  Removes the Dynamic Island row from a DSH profile patch file.

.DESCRIPTION
  Deletes the marked `insert` block this package's install.ps1 wrote, leaving the
  rest of cordis.patch.yml untouched. The previous file is copied to
  `cordis.patch.yml.bak-<timestamp>` first; if nothing but the block was present,
  the patch is left as `[]` (an empty patch file would fail boot).

.PARAMETER ProfileDir
  Profile directory to patch. Defaults to $env:DSH_PROFILE_DIR, else
  $env:DSH_HOME/profiles/$ProfileName.

.PARAMETER ProfileName
  Profile name used when DSH_PROFILE_DIR is not set. Defaults to $env:DSH_PROFILE,
  else "desktop".

.PARAMETER KeepRunning
  Leave the desktop overlay running and keep its autostart entry; only remove the
  loader row.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\uninstall.ps1
#>
[CmdletBinding()]
param(
  [string]$ProfileDir = $env:DSH_PROFILE_DIR,
  [string]$ProfileName = $env:DSH_PROFILE,
  [switch]$KeepRunning
)

$ErrorActionPreference = 'Stop'

if (-not $ProfileDir) {
  $dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
  if (-not $ProfileName) { $ProfileName = 'desktop' }
  $ProfileDir = Join-Path (Join-Path $dshHome 'profiles') $ProfileName
}

$patchPath = Join-Path $ProfileDir 'cordis.patch.yml'
if (-not (Test-Path -LiteralPath $patchPath)) { throw "uninstall: patch file not found: $patchPath" }

$begin = '# >>> dsh-plugin-dynamic-island >>>'
$end = '# <<< dsh-plugin-dynamic-island <<<'
$original = [System.IO.File]::ReadAllText($patchPath)
$newline = if ($original.Contains("`r`n")) { "`r`n" } else { "`n" }
$pattern = "(?ms)^[ \t]*" + [regex]::Escape($begin) + ".*?" + [regex]::Escape($end) + "[ \t]*\r?\n?"
$stripped = [regex]::Replace($original, $pattern, '')

if ($stripped -eq $original) {
  Write-Host 'Dynamic Island is not installed in this profile; nothing to do.' -ForegroundColor Yellow
  return
}

$backupPath = "$patchPath.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
Copy-Item -LiteralPath $patchPath -Destination $backupPath

$remainder = $stripped.Trim()
$content = if ($remainder.Length -eq 0 -or $remainder -eq '[]') { "[]$newline" } else { $remainder.TrimEnd() + $newline }
[System.IO.File]::WriteAllText($patchPath, $content, (New-Object System.Text.UTF8Encoding($false)))

Write-Host 'Dynamic Island removed.' -ForegroundColor Green
Write-Host "  profile patch : $patchPath"
Write-Host "  backup        : $backupPath"

# Stop the desktop overlay and drop its autostart entry, so nothing is left running.
if (-not $KeepRunning) {
  $overlayDir = Join-Path $PSScriptRoot 'overlay'
  $stopScript = Join-Path $overlayDir 'stop-island.cmd'
  if (Test-Path -LiteralPath $stopScript) { & $stopScript | Out-Null }
  $autostart = Join-Path $overlayDir 'setup-autostart.ps1'
  if (Test-Path -LiteralPath $autostart) { & $autostart -Remove | Out-Null }
}

Write-Host 'Refresh the Harness page to unload the client half.'
