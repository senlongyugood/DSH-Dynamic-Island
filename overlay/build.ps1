<#
.SYNOPSIS
  Builds DynamicIsland.exe from DynamicIsland.cs with a single Roslyn csc invocation.

.DESCRIPTION
  The overlay is one C# source file with no XAML and no NuGet dependencies, so it
  compiles straight to a .NET Framework WPF executable. `-codepage:65001` keeps the
  Chinese UI strings intact (csc otherwise reads a BOM-less source as ANSI).

.PARAMETER Configuration
  Debug (default) keeps optimizations off; Release turns them on.

.PARAMETER Csc
  Explicit path to csc.exe. Defaults to the VS 2022 Roslyn compiler, then the
  .NET Framework compiler.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\build.ps1
#>
[CmdletBinding()]
param(
  [ValidateSet('Debug', 'Release')]
  [string]$Configuration = 'Debug',
  [string]$Csc
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$source = Join-Path $root 'DynamicIsland.cs'
$output = Join-Path $root 'DynamicIsland.exe'

if (-not (Test-Path -LiteralPath $source)) { throw "build: source not found: $source" }

# Windows locks a running executable's image, and a failed overwrite would leave
# the old build in place; refuse loudly instead of shipping a stale binary.
$running = Get-Process -Name 'DynamicIsland' -ErrorAction SilentlyContinue
if ($running) {
  $ids = ($running | ForEach-Object { $_.Id }) -join ', '
  throw "build: DynamicIsland is running (pid $ids). Stop it first: .\stop-island.cmd"
}

if (-not $Csc) {
  $candidates = @(
    'E:\program\visualstdio2022\MSBuild\Current\Bin\Roslyn\csc.exe',
    'C:\Program Files\Microsoft Visual Studio\2022\Community\MSBuild\Current\Bin\Roslyn\csc.exe',
    'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\MSBuild\Current\Bin\Roslyn\csc.exe',
    "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
  )
  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate) { $Csc = $candidate; break }
  }
}
if (-not $Csc -or -not (Test-Path -LiteralPath $Csc)) { throw 'build: no C# compiler found; pass -Csc <path to csc.exe>' }

# Roslyn csc does not resolve bare framework assembly names, so pick a real
# reference-assembly directory (the .NET Framework targeting pack) and reference
# each WPF assembly by absolute path.
$wpfAssemblies = @('PresentationFramework.dll', 'PresentationCore.dll', 'WindowsBase.dll', 'System.Xaml.dll', 'System.Web.Extensions.dll')
$frameworkRoot = 'C:\Program Files (x86)\Reference Assemblies\Microsoft\Framework\.NETFramework'
$referenceDir = $null
if (Test-Path -LiteralPath $frameworkRoot) {
  $referenceDir = Get-ChildItem -LiteralPath $frameworkRoot -Directory |
    Where-Object { $_.Name -match '^v4\.\d+(\.\d+)*$' -and (Test-Path -LiteralPath (Join-Path $_.FullName 'PresentationFramework.dll')) } |
    Sort-Object { [version]($_.Name.TrimStart('v')) } -Descending |
    Select-Object -First 1 -ExpandProperty FullName
}

$referencePaths = @()
if ($referenceDir) {
  $referencePaths = $wpfAssemblies | ForEach-Object { Join-Path $referenceDir $_ }
} else {
  foreach ($assembly in $wpfAssemblies) {
    $found = Get-ChildItem -LiteralPath 'C:\Windows\Microsoft.NET\assembly' -Recurse -Filter $assembly -ErrorAction SilentlyContinue |
      Where-Object { $_.FullName -notmatch 'GAC_32' } | Select-Object -First 1 -ExpandProperty FullName
    if (-not $found) { throw "build: cannot locate $assembly (no targeting pack and no GAC copy)" }
    $referencePaths += $found
  }
}
foreach ($path in $referencePaths) {
  if (-not (Test-Path -LiteralPath $path)) { throw "build: missing reference assembly: $path" }
}

$references = $referencePaths | ForEach-Object { '/reference:' + $_ }

$arguments = @(
  '/nologo',
  '/target:winexe',
  '/platform:anycpu',
  '/codepage:65001',
  '/langversion:7.3',
  "/out:$output",
  "/define:$($Configuration.ToUpperInvariant())"
)
if ($Configuration -eq 'Release') { $arguments += '/optimize+' }
$arguments += $references
$arguments += $source

Write-Host "compiler : $Csc" -ForegroundColor DarkGray
Write-Host "source   : $source" -ForegroundColor DarkGray
& $Csc @arguments
if ($LASTEXITCODE -ne 0) { throw "build: csc failed with exit code $LASTEXITCODE" }
if (-not (Test-Path -LiteralPath $output)) { throw 'build: compiler produced no output' }

$info = Get-Item -LiteralPath $output
Write-Host ("built    : {0} ({1:N0} bytes)" -f $info.FullName, $info.Length) -ForegroundColor Green
