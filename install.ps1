<#
.SYNOPSIS
  Installs the Dynamic Island plugin into a DSH profile patch file.

.DESCRIPTION
  Adds (or refreshes) one marked `insert` row in the profile's cordis.patch.yml
  that mounts this package by absolute path. The write is idempotent: an existing
  marked block is replaced, everything else in the file is preserved, and the
  previous file is copied to `cordis.patch.yml.bak-<timestamp>` first.

  DSH's HMR watches the profile patch, so a running app usually picks the row up
  immediately; a browser refresh then loads the client half.

.PARAMETER ProfileDir
  Profile directory to patch. Defaults to $env:DSH_PROFILE_DIR, else
  $env:DSH_HOME/profiles/$ProfileName.

.PARAMETER ProfileName
  Profile name used when DSH_PROFILE_DIR is not set. Defaults to $env:DSH_PROFILE,
  else "desktop".

.PARAMETER EntryPoint
  Module the Loader row imports. Defaults to this package's lib/boot.js — the stable
  shim that loads the current implementation revision, so host-half edits never
  require a full Harness restart.

.PARAMETER NoStart
  Do not start the desktop overlay after installing.

.PARAMETER AutoStart
  Also register the overlay to start with Windows (see overlay\setup-autostart.ps1).

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -AutoStart
#>
[CmdletBinding()]
param(
  [string]$ProfileDir = $env:DSH_PROFILE_DIR,
  [string]$ProfileName = $env:DSH_PROFILE,
  [string]$EntryPoint,
  [switch]$NoStart,
  [switch]$AutoStart
)

$ErrorActionPreference = 'Stop'

$pluginRoot = $PSScriptRoot
if (-not $EntryPoint) { $EntryPoint = Join-Path $pluginRoot 'lib/boot.js' }
if (-not (Test-Path -LiteralPath $EntryPoint)) { throw "install: entry point not found: $EntryPoint" }
if (-not (Test-Path -LiteralPath (Join-Path $pluginRoot 'lib/client.js'))) { throw "install: lib/client.js not found next to $EntryPoint" }

if (-not $ProfileDir) {
  $dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
  if (-not $ProfileName) { $ProfileName = 'desktop' }
  $ProfileDir = Join-Path (Join-Path $dshHome 'profiles') $ProfileName
}
if (-not (Test-Path -LiteralPath $ProfileDir)) { throw "install: profile directory not found: $ProfileDir" }

$patchPath = Join-Path $ProfileDir 'cordis.patch.yml'
$specifier = ($EntryPoint -replace '\\', '/')
$begin = '# >>> dsh-plugin-dynamic-island >>>'
$end = '# <<< dsh-plugin-dynamic-island <<<'

$original = if (Test-Path -LiteralPath $patchPath) { [System.IO.File]::ReadAllText($patchPath) } else { '' }
$newline = if ($original.Contains("`r`n")) { "`r`n" } else { "`n" }
$block = @(
  $begin
  '- insert:'
  '    - id: dynamic-island'
  "      name: '$specifier'"
  $end
) -join $newline

$backupPath = $null
if (Test-Path -LiteralPath $patchPath) {
  $backupPath = "$patchPath.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
  Copy-Item -LiteralPath $patchPath -Destination $backupPath
}

$pattern = "(?ms)^[ \t]*" + [regex]::Escape($begin) + ".*?" + [regex]::Escape($end) + "[ \t]*\r?\n?"
$stripped = [regex]::Replace($original, $pattern, '')
$remainder = $stripped.Trim()
if ($remainder -eq '[]') { $remainder = '' }
$content = if ($remainder.Length -eq 0) { $block } else { "$remainder$newline$newline$block" }
$content = $content.TrimEnd() + $newline

# Written without a BOM: a byte-order mark before the YAML document is not wanted
# by the profile loader.
[System.IO.File]::WriteAllText($patchPath, $content, (New-Object System.Text.UTF8Encoding($false)))

Write-Host 'Dynamic Island installed.' -ForegroundColor Green
Write-Host "  profile patch : $patchPath"
if ($backupPath) { Write-Host "  backup        : $backupPath" }
Write-Host "  loader row    : id=dynamic-island  name=$specifier"

# The loader row feeds the overlay; the overlay itself is a small desktop app that has to run.
$overlayDir = Join-Path $pluginRoot 'overlay'
$exe = Join-Path $overlayDir 'DynamicIsland.exe'
$startScript = Join-Path $overlayDir 'start-island.cmd'
if (-not (Test-Path -LiteralPath $exe)) {
  Write-Host ''
  Write-Host "The desktop overlay ($exe) is missing." -ForegroundColor Yellow
  Write-Host 'Build it with: powershell -NoProfile -ExecutionPolicy Bypass -File overlay\build.ps1'
}
elseif (-not $NoStart) {
  if (Test-Path -LiteralPath $startScript) {
    & $startScript | Out-Null
    Write-Host '  desktop island: started (top center, always on)'
  } else {
    Start-Process -FilePath $exe -ArgumentList @('--always-show') -WorkingDirectory $overlayDir | Out-Null
    Write-Host '  desktop island: started'
  }
}

if ($AutoStart) {
  $autostart = Join-Path $overlayDir 'setup-autostart.ps1'
  if (Test-Path -LiteralPath $autostart) {
    & $autostart | Out-Null
    Write-Host '  autostart     : registered (starts with Windows)'
  }
}

Write-Host ''
Write-Host 'Next: refresh the Harness page (or restart the app) so the host and client halves load.'
Write-Host 'The island then sits at the top center of the desktop: hover it for the task list and'
Write-Host "each task's context usage, click a task to open it in Harness, use × to clear one."
