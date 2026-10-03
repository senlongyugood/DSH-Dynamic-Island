<#
.SYNOPSIS
  Builds the self-contained release folder and zip for this plugin.

.DESCRIPTION
  Copies everything a fresh machine needs into `dist\<name>-<version>`: the host and client
  halves, the prebuilt desktop overlay plus its sources, the dev test suites, the docs, and the
  install/uninstall scripts. Logs, state files, screenshots taken during development and test
  artifacts are left out.

  The result is then verified from the copy itself: the PowerShell scripts must parse, the
  shipped exe must answer /health, and the dev suites must pass when run from the extracted
  folder — so a package that only works in this checkout cannot be published by accident.

.PARAMETER OutDir
  Where the release folder and zip go. Defaults to `dist` next to this package.

.PARAMETER SkipVerify
  Skip the post-copy verification (the checks are the point, so this is for emergencies only).

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\dev\pack.ps1
#>
[CmdletBinding()]
param(
  [string]$OutDir,
  [switch]$SkipVerify
)

$ErrorActionPreference = 'Stop'

$pluginRoot = Split-Path $PSScriptRoot -Parent
if (-not $OutDir) { $OutDir = Join-Path $pluginRoot 'dist' }

$manifest = Get-Content -LiteralPath (Join-Path $pluginRoot 'package.json') -Raw | ConvertFrom-Json
$name = "$($manifest.name)-$($manifest.version)"
$stage = Join-Path $OutDir $name
$zip = Join-Path $OutDir "$name.zip"

# Everything a user needs; `docs` shows what it looks like, `dev` proves it works there too.
$include = @('package.json', 'README.md', 'INSTALL.md', 'LICENSE', 'install.ps1', 'uninstall.ps1',
             'lib', 'overlay', 'dev', 'docs')
# Never ship logs, state files, settings a machine chose, or build/test output.
$excludeFiles = @('*.log', '*.state', '*.state.txt', '*.state.json', '*.settings.json', '*.bak-*', '*.tmp')
$excludeDirs = @('dist', 'node_modules', '.git', 'obj', 'bin')

if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage -Force | Out-Null

$copied = 0
foreach ($entry in $include) {
  $source = Join-Path $pluginRoot $entry
  if (-not (Test-Path -LiteralPath $source)) {
    if ($entry -eq 'INSTALL.md' -or $entry -eq 'LICENSE') {
      Write-Host "pack: $entry is missing (continuing)" -ForegroundColor Yellow
      continue
    }
    throw "pack: required entry is missing: $source"
  }
  $target = Join-Path $stage $entry
  if (Test-Path -LiteralPath $source -PathType Container) {
    New-Item -ItemType Directory -Path $target -Force | Out-Null
    Get-ChildItem -LiteralPath $source -Recurse -File | ForEach-Object {
      $relative = $_.FullName.Substring($source.Length).TrimStart('\')
      $leaf = $_.Name
      $skip = $false
      foreach ($dir in $excludeDirs) {
        if ($relative -eq $dir -or $relative -like "$dir\*") { $skip = $true; break }
      }
      if (-not $skip) {
        foreach ($pattern in $excludeFiles) {
          if ($leaf -like $pattern) { $skip = $true; break }
        }
      }
      if ($skip) { return }
      $destination = Join-Path $target $relative
      New-Item -ItemType Directory -Path (Split-Path $destination -Parent) -Force | Out-Null
      Copy-Item -LiteralPath $_.FullName -Destination $destination -Force
      $script:copied++
    }
  } else {
    Copy-Item -LiteralPath $source -Destination $target -Force
    $copied++
  }
}

Write-Host "pack: staged $copied file(s) in $stage" -ForegroundColor Green

if (-not $SkipVerify) {
  Write-Host 'pack: verifying the staged copy' -ForegroundColor DarkGray

  # 1. Every PowerShell script in the package must at least parse.
  $broken = @()
  Get-ChildItem -LiteralPath $stage -Recurse -Filter '*.ps1' | ForEach-Object {
    $errors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile($_.FullName, [ref]$null, [ref]$errors)
    if ($errors -and $errors.Count -gt 0) { $broken += "$($_.Name): $($errors[0].Message)" }
  }
  if ($broken.Count -gt 0) { throw "pack: scripts do not parse:`n  $($broken -join "`n  ")" }
  Write-Host 'pack:   all PowerShell scripts parse' -ForegroundColor DarkGray

  # 2. The shipped overlay must run from the copied folder.
  $exe = Join-Path $stage 'overlay\DynamicIsland.exe'
  $probeInfo = New-Object System.Diagnostics.ProcessStartInfo
  $probeInfo.FileName = $exe
  $probeInfo.Arguments = "--port 19431 --url http://127.0.0.1:19499/island --discovery `"$(Join-Path $env:TEMP 'dsh-island-none.json')`" --settings `"$(Join-Path $env:TEMP 'dsh-island-pack-settings.json')`" --always-show"
  $probeInfo.UseShellExecute = $false
  $probeInfo.WorkingDirectory = (Join-Path $stage 'overlay')
  $probe = [System.Diagnostics.Process]::Start($probeInfo)
  try {
    Start-Sleep -Seconds 3
    $health = (Invoke-WebRequest 'http://127.0.0.1:19431/health' -UseBasicParsing -TimeoutSec 5).Content
    if ($health -ne 'dynamic-island-overlay') { throw "pack: the shipped overlay answered /health with '$health'" }
    Write-Host 'pack:   the shipped overlay runs and answers /health' -ForegroundColor DarkGray
  }
  finally {
    if ($probe -and -not $probe.HasExited) { Stop-Process -Id $probe.Id -Force -ErrorAction SilentlyContinue }
  }

  # 3. The dev suites must pass from the copied folder (they use only relative paths).
  foreach ($suite in @('dev\autostart-test.mjs', 'dev\component-test.mjs', 'dev\server-test.mjs', 'dev\collect-test.mjs', 'dev\host-half-test.mjs')) {
    $output = & node (Join-Path $stage $suite) 2>&1
    if ($LASTEXITCODE -ne 0) { throw "pack: $suite failed in the staged copy:`n$($output -join "`n")" }
    $count = ($output | Select-String '^OK ').Count
    Write-Host ("pack:   {0,-24} {1} assertions" -f $suite, $count) -ForegroundColor DarkGray
  }
}

# The verification above runs the suites inside the staged copy, and they leave a state file
# behind; clear anything excluded one more time so the zip only carries the release itself.
$removed = 0
Get-ChildItem -LiteralPath $stage -Recurse -File | ForEach-Object {
  $leaf = $_.Name
  foreach ($pattern in $excludeFiles) {
    if ($leaf -like $pattern) {
      Remove-Item -LiteralPath $_.FullName -Force
      $script:removed++
      break
    }
  }
}
if ($removed -gt 0) { Write-Host "pack: cleared $removed generated file(s) before zipping" -ForegroundColor DarkGray }

if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -CompressionLevel Optimal

$size = [math]::Round((Get-Item -LiteralPath $zip).Length / 1MB, 2)
Write-Host ''
Write-Host "Release built: $zip ($size MB)" -ForegroundColor Green
Write-Host "  folder : $stage"
Write-Host '  install: unzip anywhere, then run install.ps1 (see INSTALL.md)'
