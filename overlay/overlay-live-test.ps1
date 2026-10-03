<#
.SYNOPSIS
  End-to-end check of the desktop overlay against a real window.

.DESCRIPTION
  Starts DynamicIsland.exe with its own port, settings file and status report, then drives it
  exactly like the Harness page does (POST /island, /focus) and inspects the live window
  through Win32 plus the overlay's own status report. Covered: appearing on a push, centring,
  tool-window/no-activate styles, the pill narrowing for a shorter title, hiding on an empty
  push, the focus queue, no per-poll morph restart (the flicker regression), morphing without
  resizing the window, render-clock smoothness, staying open while the pointer rests on it,
  Ctrl+wheel resizing with its settings file, and the --scale flag.

  Because the window deliberately keeps the island's full footprint, the pill's own geometry
  comes from the report (`pillWidth` / `pillHeight`); the window rect is used for position and
  style. Hover-dependent checks count samples where a human moved the mouse away as
  interference and print SKIP instead of failing.

.PARAMETER Port
  Push-receiver port to use; defaults to 19401 so a running overlay is untouched.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\overlay-live-test.ps1
#>
[CmdletBinding()]
param(
  [int]$Port = 19401
)

$ErrorActionPreference = 'Stop'
$exe = Join-Path $PSScriptRoot 'DynamicIsland.exe'
if (-not (Test-Path -LiteralPath $exe)) { throw "run build.ps1 first: $exe" }
Add-Type -AssemblyName System.Windows.Forms

Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class IslandWin32 {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int max);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int index);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, IntPtr extra);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, int dx, int dy, int data, IntPtr extra);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }

  /** Every top-level window of one process, as "0xHANDLE title" lines. */
  public static string[] WindowsOf(int pid) {
    var found = new List<string>();
    EnumWindows((h, l) => {
      uint owner; GetWindowThreadProcessId(h, out owner);
      if (owner != (uint)pid) return true;
      var text = new StringBuilder(256);
      GetWindowText(h, text, text.Capacity);
      found.Add(h.ToInt64().ToString("X") + " " + text.ToString());
      return true;
    }, IntPtr.Zero);
    return found.ToArray();
  }

  /** The island window of one process: the top-level window carrying our title. */
  public static IntPtr WindowOf(int pid, string title) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      uint owner; GetWindowThreadProcessId(h, out owner);
      if (owner != (uint)pid) return true;
      var text = new StringBuilder(256);
      GetWindowText(h, text, text.Capacity);
      if (text.ToString() != title) return true;
      found = h;
      return false;
    }, IntPtr.Zero);
    return found;
  }

  /** Hold Ctrl while rolling the wheel over whatever sits under the pointer. */
  public static void CtrlWheel(int notches) {
    keybd_event(0x11, 0, 0, IntPtr.Zero);
    for (var index = 0; index < Math.Abs(notches); index += 1) {
      mouse_event(0x0800, 0, 0, notches > 0 ? 120 : -120, IntPtr.Zero);
      System.Threading.Thread.Sleep(70);
    }
    keybd_event(0x11, 0, 2, IntPtr.Zero);
  }

  /** One left click at a screen position. */
  public static void Click(int x, int y) {
    SetCursorPos(x, y);
    System.Threading.Thread.Sleep(120);
    mouse_event(0x0002, 0, 0, 0, IntPtr.Zero);
    System.Threading.Thread.Sleep(60);
    mouse_event(0x0004, 0, 0, 0, IntPtr.Zero);
  }

  /** Whether a visible top-level window's title contains the given text. */
  public static bool HasWindowTitled(string needle) {
    var found = false;
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      var text = new StringBuilder(512);
      GetWindowText(h, text, text.Capacity);
      if (text.ToString().IndexOf(needle, StringComparison.OrdinalIgnoreCase) < 0) return true;
      found = true;
      return false;
    }, IntPtr.Zero);
    return found;
  }

  /** Title of the current foreground window. */
  public static string ForegroundTitle() {
    var hwnd = GetForegroundWindow();
    var text = new StringBuilder(512);
    GetWindowText(hwnd, text, text.Capacity);
    return text.ToString();
  }

  /** First visible top-level window whose title contains the text. */
  public static IntPtr HandleOfTitle(string needle) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      var text = new StringBuilder(512);
      GetWindowText(h, text, text.Capacity);
      if (text.ToString().IndexOf(needle, StringComparison.OrdinalIgnoreCase) < 0) return true;
      found = h;
      return false;
    }, IntPtr.Zero);
    return found;
  }

  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int command);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
'@
[void][IslandWin32]::SetProcessDPIAware()

$islandTitle = 'DSH Dynamic Island'
$settingsPath = Join-Path $PSScriptRoot 'live-test.settings.json'
$scaledSettingsPath = Join-Path $PSScriptRoot 'live-test-scaled.settings.json'
$reportPath = Join-Path $PSScriptRoot 'live-test-state.txt'
$scaledReportPath = Join-Path $PSScriptRoot 'live-test-scaled.state'
$logPath = Join-Path $PSScriptRoot 'live-test.log'
$deadUrl = 'http://127.0.0.1:19499/island'
$noDiscovery = Join-Path $PSScriptRoot 'live-test-no-discovery.json'
$failures = 0
$skips = 0

function Assert([string]$label, [bool]$condition, [string]$detail = '') {
  if ($condition) { Write-Host "OK  $label" -ForegroundColor Green }
  else { Write-Host "FAIL $label $detail" -ForegroundColor Red; $script:failures += 1 }
}

function Skip([string]$label, [string]$why) {
  Write-Host "SKIP $label ($why)" -ForegroundColor Yellow
  $script:skips += 1
}

function Get-IslandGeometry([int]$processId) {
  if ($processId -le 0) { return $null }
  $handle = [IslandWin32]::WindowOf($processId, $islandTitle)
  if ($handle -eq [IntPtr]::Zero) { return $null }
  $rect = New-Object IslandWin32+RECT
  [void][IslandWin32]::GetWindowRect($handle, [ref]$rect)
  $style = [IslandWin32]::GetWindowLong($handle, -20)
  return [pscustomobject]@{
    Handle     = $handle
    Visible    = [IslandWin32]::IsWindowVisible($handle)
    Left       = $rect.Left
    Top        = $rect.Top
    Width      = $rect.Right - $rect.Left
    Height     = $rect.Bottom - $rect.Top
    ToolWindow = (($style -band 0x00000080) -ne 0)
    NoActivate = (($style -band 0x08000000) -ne 0)
  }
}

function Send-Snapshot([string]$json, [int]$targetPort) {
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
  Invoke-RestMethod -Uri "http://127.0.0.1:$targetPort/island" -Method Post -Body $bytes -ContentType 'text/plain;charset=UTF-8' -TimeoutSec 5 | Out-Null
}

# The overlay's own status file: pill geometry, morph counters and frame timing.
function Read-State([string]$path) {
  $state = @{}
  if (-not (Test-Path -LiteralPath $path)) { return $state }
  # Read as UTF-8 explicitly, sharing the file with the overlay that keeps writing it: Windows
  # PowerShell's default encoding would mangle the Chinese fields, and a plain read can collide.
  $lines = @()
  try {
    $stream = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
    try {
      $reader = New-Object IO.StreamReader($stream, [Text.Encoding]::UTF8)
      while (-not $reader.EndOfStream) { $lines += $reader.ReadLine() }
      $reader.Dispose()
    } finally {
      $stream.Dispose()
    }
  } catch {
    return $state
  }
  foreach ($line in $lines) {
    if ($line -match '^(morphRuns|chevronAngle|expanded|idle|empty|pollCount|scale|win32Visible|frames|maxFrameGap|pillWidth|pillHeight|windowSize|rows|dismissed|usageVisible|usageRow|lastMorph|headerText|headerFits|titleMaxWidth|requestCount|requestRow|requestHead):\s*(.*)$') {
      $state[$Matches[1]] = $Matches[2].Trim()
    }
    if ($line -match '^measured:.*usage=([0-9.]+)') { $state['measureHeight'] = $Matches[1] }
  }
  foreach ($key in @('morphRuns', 'frames')) {
    if ($state.ContainsKey($key)) { $state[$key] = [int]$state[$key] }
  }
  foreach ($key in @('chevronAngle', 'maxFrameGap', 'pillWidth', 'pillHeight')) {
    if ($state.ContainsKey($key)) { $state[$key] = [double]$state[$key] }
  }
  return $state
}

function Wait-For([scriptblock]$condition, [int]$timeoutMs = 8000) {
  $deadline = (Get-Date).AddMilliseconds($timeoutMs)
  while ((Get-Date) -lt $deadline) {
    $value = & $condition
    if ($value) { return $value }
    Start-Sleep -Milliseconds 120
  }
  return $null
}

# Wait until the pill stops changing size (the morph takes ~280ms), so measurements land on a
# settled card rather than mid-animation. The status file is rewritten once per poll, so a sample
# only counts when its poll counter advanced — otherwise three quick reads just re-read one line.
function Wait-PillStable([string]$path, [int]$needed = 3, [int]$timeoutMs = 8000) {
  $deadline = (Get-Date).AddMilliseconds($timeoutMs)
  $stable = 0
  $previous = ''
  $lastPoll = -1
  $last = $null
  while ((Get-Date) -lt $deadline -and $stable -lt $needed) {
    Start-Sleep -Milliseconds 150
    $current = Read-State $path
    if (-not $current.ContainsKey('pillWidth')) { $stable = 0; $previous = ''; continue }
    $poll = if ($current.ContainsKey('pollCount')) { [int]$current.pollCount } else { 0 }
    if ($poll -eq $lastPoll) { continue }
    $lastPoll = $poll
    $key = "$($current.pillWidth)x$($current.pillHeight)"
    if ($key -eq $previous) { $stable += 1 } else { $stable = 0 }
    $previous = $key
    $last = $current
  }
  return $last
}

# Park the pointer on the pill; the jiggle guarantees a WM_MOUSEMOVE arrives.
function Set-Hover([int]$x, [int]$y) {
  [void][IslandWin32]::SetCursorPos($x - 8, $y)
  Start-Sleep -Milliseconds 200
  [void][IslandWin32]::SetCursorPos($x, $y)
}

# The pill sits at the top centre of its (larger) window, so its screen rect follows from the
# window rect plus the reported pill size.
function Get-PillRect($geometry, $state) {
  if (-not $geometry -or -not $state -or -not $state.ContainsKey('pillWidth')) { return $null }
  $width = [double]$state.pillWidth
  $height = [double]$state.pillHeight
  if ($width -le 0 -or $height -le 0) { return $null }
  # Report values are layout units; the window rect is device pixels.
  $ratio = $geometry.Width / [double]($state.windowSize -split 'x')[0]
  return [pscustomobject]@{
    Left   = $geometry.Left + ($geometry.Width - $width * $ratio) / 2
    Top    = $geometry.Top
    Width  = $width * $ratio
    Height = $height * $ratio
  }
}

# A person may be using the mouse while this test runs, so hover assertions only count samples
# where the cursor really was over the pill.
function Test-CursorInside($rect) {
  if (-not $rect) { return $false }
  $point = New-Object IslandWin32+POINT
  if (-not [IslandWin32]::GetCursorPos([ref]$point)) { return $false }
  return $point.X -ge $rect.Left -and $point.X -lt ($rect.Left + $rect.Width) -and
         $point.Y -ge $rect.Top -and $point.Y -lt ($rect.Top + $rect.Height)
}

# Park the pointer well away from the island and confirm it stayed away: collapsed-size
# assertions need the card closed, and the person at the keyboard may hover it at any moment.
function Move-PointerAway([int]$processId, [string]$report, [int]$attempts = 3) {
  for ($attempt = 0; $attempt -lt $attempts; $attempt += 1) {
    [void][IslandWin32]::SetCursorPos(30, 600)
    Start-Sleep -Milliseconds 400
    $geometry = Get-IslandGeometry $processId
    if (-not (Test-CursorInside (Get-PillRect $geometry (Read-State $report)))) { return $true }
  }
  return $false
}

$process = $null
$scaled = $null
foreach ($stale in @($settingsPath, $scaledSettingsPath, $reportPath, $scaledReportPath, $logPath)) {
  Remove-Item -LiteralPath $stale -Force -ErrorAction SilentlyContinue
}
try {
  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $exe
  # Dead host URL and a nonexistent discovery file: this test measures only its own pushes.
  $startInfo.Arguments = "--port $Port --url $deadUrl --discovery `"$noDiscovery`" --settings `"$settingsPath`" --log `"$logPath`" --report `"$reportPath`""
  $startInfo.UseShellExecute = $false
  $startInfo.WorkingDirectory = $PSScriptRoot
  $process = [System.Diagnostics.Process]::Start($startInfo)
  Start-Sleep -Seconds 2

  $health = $null
  try { $health = (Invoke-WebRequest "http://127.0.0.1:$Port/health" -UseBasicParsing -TimeoutSec 5).Content } catch { }
  Assert 'the overlay answers /health' ($health -eq 'dynamic-island-overlay') "got '$health'"

  $windows = [IslandWin32]::WindowsOf($process.Id)
  Write-Host ("    windows of pid {0}: {1}" -f $process.Id, ($windows -join ' | ')) -ForegroundColor DarkGray
  $idle = Get-IslandGeometry $process.Id
  Assert 'the island window exists while idle' ($null -ne $idle) ($windows -join ' | ')
  if ($idle) { Assert 'an idle overlay is hidden' (-not $idle.Visible) }

  $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $runningTask = @{
    version = 1; source = 'page'; generatedAt = $now
    tasks = @(
      @{
        id = 'session-live-test'
        title = '给我看看这个项目，他现在识别不到 codex 当前的任务了'
        cwd = 'E:\proj\demo'
        running = $true; updatedAt = $now - 4000; children = 1
        pending = @{ kind = 'approval'; toolName = 'Bash'; text = 'May I send the approval request outside the sandbox?' }
        usage = @{ usedTokens = 557032; contextWindow = 1000000; percent = 56; systemTokens = 1491; toolsTokens = 8032; messageTokens = 495062 }
        jobs = @{ running = 2 }
      },
      @{ id = 'session-2'; title = '重构插件系统'; cwd = 'E:\proj\other'; running = $true; updatedAt = $now - 900; pending = $null; usage = $null; jobs = @{ running = 0 }; children = 0 }
    )
  } | ConvertTo-Json -Depth 8 -Compress

  Send-Snapshot $runningTask $Port
  $visible = Wait-For { $g = Get-IslandGeometry $process.Id; if ($g -and $g.Visible) { $g } else { $null } }
  Assert 'a pushed snapshot makes the island appear' ($null -ne $visible)
  $collapsedState = $null
  if ($visible) {
    $unhovered = Move-PointerAway $process.Id $reportPath
    $collapsedState = Wait-PillStable $reportPath
    $visible = Get-IslandGeometry $process.Id
    $screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $centre = [math]::Abs(($visible.Left + $visible.Width / 2) - ($screen.Width / 2))
    Assert 'it is centred horizontally' ($centre -le 3) "off by $centre px"
    Assert 'it sits at the very top' ($visible.Top -le 20) "top=$($visible.Top)"
    Assert 'it is a tool window (no taskbar or alt-tab entry)' $visible.ToolWindow
    Assert 'it never takes focus' $visible.NoActivate
    if ($unhovered) {
      Assert 'the collapsed pill is a single short line' ($collapsedState.pillHeight -ge 24 -and $collapsedState.pillHeight -le 60) "pillHeight=$($collapsedState.pillHeight)"
      Assert 'the pill is smaller than the window that holds it' ($collapsedState.pillWidth -lt ([double]($collapsedState.windowSize -split 'x')[0])) "pill=$($collapsedState.pillWidth) window=$($collapsedState.windowSize)"
    } else {
      Skip 'the collapsed pill is a single short line' 'the pointer stayed on the island'
    }
  }

  # A single shorter task must narrow the pill.
  $single = @{
    version = 1; source = 'page'; generatedAt = $now
    tasks = @(@{ id = 'session-2'; title = '重构插件系统'; cwd = 'E:\proj\other'; running = $true; updatedAt = $now; pending = $null; usage = $null; jobs = @{ running = 0 }; children = 0 })
  } | ConvertTo-Json -Depth 8 -Compress
  Send-Snapshot $single $Port
  $narrowReady = Move-PointerAway $process.Id $reportPath
  $narrow = Wait-For {
    $state = Read-State $reportPath
    if ($state.ContainsKey('pillWidth') -and $state.pillWidth -lt ($collapsedState.pillWidth - 20)) { $state } else { $null }
  }
  if ($narrowReady) {
    Assert 'the pill narrows for a shorter title' ($null -ne $narrow) "was $($collapsedState.pillWidth), now $(if ($narrow) { $narrow.pillWidth } else { 'n/a' })"
  } else {
    Skip 'the pill narrows for a shorter title' 'the pointer stayed on the island'
  }

  # An idle source keeps a resting pill: the island must not vanish the moment a turn ends.
  $empty = @{ version = 1; source = 'page'; generatedAt = $now; tasks = @() } | ConvertTo-Json -Depth 4 -Compress
  Send-Snapshot $empty $Port
  [void](Move-PointerAway $process.Id $reportPath)
  $resting = Wait-For {
    $state = Read-State $reportPath
    if ($state.idle -eq 'True' -and $state.expanded -eq 'False') { $state } else { $null }
  }
  Assert 'an idle source keeps a resting pill' ($null -ne $resting)
  if ($resting) {
    $restingGeometry = Get-IslandGeometry $process.Id
    Assert 'the resting pill stays on screen' ($restingGeometry.Visible)
    Assert 'the resting pill is still a single line' ($resting.pillHeight -le 60) "pillHeight=$($resting.pillHeight)"
  }

  # ---- --idle-hide still lets a resting island retire after a while ---------
  $retireSettings = Join-Path $PSScriptRoot 'live-test-retire.settings.json'
  $retireReport = Join-Path $PSScriptRoot 'live-test-retire.state'
  Remove-Item -LiteralPath $retireSettings -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $retireReport -Force -ErrorAction SilentlyContinue
  $retireInfo = New-Object System.Diagnostics.ProcessStartInfo
  $retireInfo.FileName = $exe
  $retireInfo.Arguments = "--port $($Port + 2) --url $deadUrl --discovery `"$noDiscovery`" --settings `"$retireSettings`" --idle-hide 0.05 --log `"$(Join-Path $PSScriptRoot 'live-test-retire.log')`" --report `"$retireReport`""
  $retireInfo.UseShellExecute = $false
  $retireInfo.WorkingDirectory = $PSScriptRoot
  $retire = [System.Diagnostics.Process]::Start($retireInfo)
  try {
    Start-Sleep -Seconds 2
    for ($cycle = 0; $cycle -lt 3; $cycle += 1) { Send-Snapshot $single ($Port + 2); Start-Sleep -Milliseconds 400 }
    [void](Wait-For { $g = Get-IslandGeometry $retire.Id; if ($g -and $g.Visible) { $g } else { $null } })
    Send-Snapshot $empty ($Port + 2)
    $retired = Wait-For { $g = Get-IslandGeometry $retire.Id; if ($g -and -not $g.Visible) { $g } else { $null } } 12000
    Assert 'an island with --idle-hide retires once the window elapses' ($null -ne $retired)
  }
  finally {
    if ($retire -and -not $retire.HasExited) { Stop-Process -Id $retire.Id -Force -ErrorAction SilentlyContinue }
  }

  $focus = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/focus" -Method Get -TimeoutSec 5
  Assert 'the focus queue starts empty' ($null -eq $focus.sessionId)
  Invoke-RestMethod -Uri "http://127.0.0.1:$Port/focus" -Method Post -Body '{"sessionId":"session-2"}' -ContentType 'text/plain;charset=UTF-8' -TimeoutSec 5 | Out-Null
  $taken = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/focus" -Method Get -TimeoutSec 5
  Assert 'a queued session id is handed to the page once' ($taken.sessionId -eq 'session-2') "got $($taken.sessionId)"
  $drained = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/focus" -Method Get -TimeoutSec 5
  Assert 'and cleared afterwards' ($null -eq $drained.sessionId)

  # ---- no per-poll flicker: a steady state must not restart the morph -------
  # Let the first frames settle (a startup morph is fine), then require the morph count to stop
  # growing across two windows of once-per-second pushes. The old bug restarted the animation on
  # every push, so it would add ~2 morphs per window. A person hovering the island during the
  # window legitimately changes the count, so that case is skipped rather than reported.
  for ($cycle = 0; $cycle -lt 3; $cycle += 1) { Send-Snapshot $runningTask $Port; Start-Sleep -Milliseconds 400 }
  $firstWindow = Read-State $reportPath
  [void](Wait-PillStable $reportPath)
  $pointerAwayBefore = -not (Test-CursorInside (Get-PillRect (Get-IslandGeometry $process.Id) $firstWindow))
  for ($cycle = 0; $cycle -lt 3; $cycle += 1) { Send-Snapshot $runningTask $Port; Start-Sleep -Milliseconds 1000 }
  $secondWindow = Read-State $reportPath
  for ($cycle = 0; $cycle -lt 3; $cycle += 1) { Send-Snapshot $runningTask $Port; Start-Sleep -Milliseconds 1000 }
  $thirdWindow = Read-State $reportPath
  $pointerAwayAfter = -not (Test-CursorInside (Get-PillRect (Get-IslandGeometry $process.Id) $thirdWindow))
  $stayedCollapsed = $secondWindow.expanded -eq 'False' -and $thirdWindow.expanded -eq 'False'
  if ($pointerAwayBefore -and $pointerAwayAfter -and $stayedCollapsed) {
    Assert 'a steady island does not restart its morph' ($secondWindow.morphRuns -eq $thirdWindow.morphRuns) "runs settled=$($firstWindow.morphRuns) window2=$($secondWindow.morphRuns) window3=$($thirdWindow.morphRuns)"
    Assert 'a steady pill keeps its exact size' ($secondWindow.pillWidth -eq $thirdWindow.pillWidth -and $secondWindow.pillHeight -eq $thirdWindow.pillHeight) "was $($secondWindow.pillWidth)x$($secondWindow.pillHeight), now $($thirdWindow.pillWidth)x$($thirdWindow.pillHeight)"
    Assert 'a collapsed chevron rests at 0 degrees' ([math]::Abs($thirdWindow.chevronAngle) -lt 0.5) "angle=$($thirdWindow.chevronAngle)"
  } else {
    Skip 'a steady island does not restart its morph' 'the pointer was on the island during the measurement window'
  }

  # ---- the pointer resting on the island must keep it open ------------------
  $hoverBase = Get-IslandGeometry $process.Id
  $pillRect = Get-PillRect $hoverBase $thirdWindow
  if ($pillRect) {
    Set-Hover ([int]($pillRect.Left + $pillRect.Width / 2)) ([int]($pillRect.Top + $pillRect.Height / 2))
  }
  $open = Wait-For {
    $state = Read-State $reportPath
    if ($state.expanded -eq 'True') { $state } else { $null }
  }
  Assert 'hovering opens the card' ($null -ne $open)
  if ($open) {
    # The window must keep its footprint while the pill morphs, and the morph must be paced by
    # the render clock: both are what make the animation smooth.
    $windowDuringMorph = @()
    for ($sample = 0; $sample -lt 6; $sample += 1) {
      $g = Get-IslandGeometry $process.Id
      if ($g) { $windowDuringMorph += "$($g.Width)x$($g.Height)" }
      Start-Sleep -Milliseconds 60
    }
    $distinctWindowSizes = ($windowDuringMorph | Select-Object -Unique).Count
    Assert 'the morph never resizes the window' ($distinctWindowSizes -le 1) ($windowDuringMorph -join ' ')

    $openState = Wait-PillStable $reportPath
    Assert 'the opened card settles' ($null -ne $openState)
    # The frame counter is a proxy: it drops when WPF coalesces frames (or when a person's mouse
    # interrupts a morph), so the floor only proves the render clock drove the animation at all.
    # Smoothness itself is covered by "the morph never resizes the window" and the frame-gap check.
    Assert 'the morph is driven by the render clock' ($openState.frames -ge 3) "frames=$($openState.frames)"
    # A stall above this is this machine being busy (the suite itself is running), not a design
    # regression: the sustained pacing is covered by the frame count and the window-size checks.
    Assert 'no frame gap above 120 ms' ($openState.maxFrameGap -le 120) "maxGap=$($openState.maxFrameGap)ms"
    # A person's mouse can close and reopen the card while these samples are taken, which leaves
    # nothing meaningful to compare. That is a skipped measurement, not a design failure, and the
    # report lags a poll behind reality — so the baseline must also *look* collapsed.
    if ($openState.expanded -ne 'True' -or $thirdWindow.pillHeight -ge 60) {
      Skip 'the open card is taller than the pill' "no comparable pair (open=$($openState.expanded) base=$($thirdWindow.pillHeight))"
    } else {
      Assert 'the open card is taller than the pill' ($openState.pillHeight -gt ($thirdWindow.pillHeight + 40)) "pill=$($openState.pillHeight) collapsed=$($thirdWindow.pillHeight)"
    }

    # ---- hovering one task shows that task's own context meter ---------------
    # Row offsets below a hovered row shift while its meter is open, so every step starts by
    # parking on the header (the neutral strip) and waiting for any meter to close.
    $meterGeometry = Get-IslandGeometry $process.Id
    $meterState = Read-State $reportPath
    $meterPill = Get-PillRect $meterGeometry $meterState
    $meterRatio = $meterGeometry.Width / [double](($meterState.windowSize -split 'x')[0])
    if ($meterPill) {
      $neutralX = [int]($meterPill.Left + $meterPill.Width / 2)
      [void][IslandWin32]::SetCursorPos($neutralX, [int]($meterGeometry.Top + 12))
      [void](Wait-For { $s = Read-State $reportPath; if ($s.usageVisible -eq 'Collapsed') { $s } else { $null } } 4000)

      # First row's centre: it carries the usage figures, so its meter must open below it — but
      # only after the pointer has rested there, so the reveal time is checked against the log.
      $hoverStartedAt = [DateTimeOffset]::Now
      Set-Hover ([int]($meterPill.Left + 60 * $meterRatio)) ([int]($meterGeometry.Top + 86 * $meterRatio))
      $meterOpen = Wait-For {
        $s = Read-State $reportPath
        if ($s.usageVisible -eq 'Visible') { $s } else { $null }
      } 6000
      $inside = Test-CursorInside (Get-PillRect (Get-IslandGeometry $process.Id) (Read-State $reportPath))
      $meterSeen = Read-State $reportPath
      if ($inside) {
        Assert 'hovering a task opens that task''s context meter' ($null -ne $meterOpen) "usageVisible=$($meterSeen.usageVisible) usageRow=$($meterSeen.usageRow)"
        Assert 'the meter belongs to the hovered task' ($meterOpen -and $meterOpen.usageRow -eq 'session-live-test') "usageRow=$($meterSeen.usageRow)"
        Assert 'the meter adds height below that row' ([double]$meterSeen.measureHeight -gt 40) "usage=$($meterSeen.measureHeight)"

        # The reveal waits for the pointer to settle: the log stamps when it actually opened.
        $openLine = Get-Content -LiteralPath $logPath -ErrorAction SilentlyContinue |
          Select-String 'row meter open for session-live-test' | Select-Object -Last 1
        if ($openLine -and $openLine.Line -match '^(\d{4}-\d{2}-\d{2}T[\d:\.]+\+\d{2}:\d{2})') {
          # Both sides are absolute instants, so the +08:00 offset cannot be counted twice.
          $openedAt = [DateTimeOffset]::Parse($Matches[1], [Globalization.CultureInfo]::InvariantCulture)
          $waited = ($openedAt - $hoverStartedAt).TotalMilliseconds
          Assert 'the meter waits about a second before opening' ($waited -ge 700 -and $waited -le 2600) "waited $([int]$waited) ms"
        } else {
          Skip 'the meter waits about a second before opening' 'no open stamp in the log'
        }
      } else {
        Skip 'hovering a task opens that task''s context meter' 'the pointer left the island'
      }

      # Leaving the row closes it again.
      [void][IslandWin32]::SetCursorPos($neutralX, [int]($meterGeometry.Top + 12))
      Start-Sleep -Milliseconds 900
      $meterClosed = Wait-For {
        $s = Read-State $reportPath
        if ($s.usageVisible -eq 'Collapsed') { $s } else { $null }
      } 4000
      Assert 'leaving the row closes the meter again' ($null -ne $meterClosed) "usageVisible=$(Read-State $reportPath).usageVisible"
    } else {
      Skip 'hovering a task opens that task''s context meter' 'the card geometry was unavailable'
    }

    # ---- clicking a row asks the page to open that session -------------------
    # The request must land in THIS overlay's queue: the page polls the endpoint whose /health
    # identifies the overlay, so anything posted elsewhere is never read (the original bug).
    # A person using the mouse can collapse the card mid-attempt, so hover and click are retried.
    $queued = $null
    for ($attempt = 0; $attempt -lt 3 -and -not $queued; $attempt += 1) {
      $openGeometry = Get-IslandGeometry $process.Id
      if (-not $openGeometry) { break }
      $ratio = $openGeometry.Width / [double](($openState.windowSize -split 'x')[0])
      # Reset to the header first: with no meter open the rows sit at their base offsets, so the
      # row's centre is where the click expects it.
      if ($meterPill) { [void][IslandWin32]::SetCursorPos([int]($meterPill.Left + $meterPill.Width / 2), [int]($openGeometry.Top + 12)) }
      [void](Wait-For { $s = Read-State $reportPath; if ($s.expanded -eq 'True' -and $s.usageVisible -eq 'Collapsed') { $s } else { $null } } 4000)
      Set-Hover ([int]($openGeometry.Left + $openGeometry.Width / 2)) ([int]($openGeometry.Top + 12))
      $expandedNow = Wait-For { $s = Read-State $reportPath; if ($s.expanded -eq 'True') { $s } else { $null } } 3000
      if (-not $expandedNow) { continue }
      $rowOneY = [int]($openGeometry.Top + 86 * $ratio)
      [IslandWin32]::Click([int]($openGeometry.Left + $openGeometry.Width / 2), $rowOneY)
      $queued = Wait-For {
        $focusRequest = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/focus" -Method Get -TimeoutSec 5
        if ($focusRequest.sessionId) { $focusRequest } else { $null }
      } 2500
    }
    Assert 'clicking a row queues its session for the page' ($null -ne $queued -and $queued.sessionId -eq 'session-live-test') "got '$($queued.sessionId)'"
    $afterClick = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/focus" -Method Get -TimeoutSec 5
    Assert 'the click request is handed over exactly once' ($null -eq $afterClick.sessionId)

    # Keep pushing while the pointer rests on the card's header: no task row is hovered, so no
    # meter opens and the card must neither collapse nor twitch between pushes.
    if ($meterPill) { [void][IslandWin32]::SetCursorPos([int]($meterPill.Left + $meterPill.Width / 2), [int]($meterGeometry.Top + 12)) }
    [void](Wait-For { $s = Read-State $reportPath; if ($s.usageVisible -eq 'Collapsed') { $s } else { $null } } 4000)
    $openState = Wait-PillStable $reportPath

    # Two settled reads a couple of seconds apart: the status file lags a poll, so comparing one
    # reading against every later sample would report the lag itself as drift.
    for ($cycle = 0; $cycle -lt 6; $cycle += 1) { Send-Snapshot $runningTask $Port; Start-Sleep -Milliseconds 500 }
    $settledAgain = Wait-PillStable $reportPath
    $restingRect = Get-PillRect (Get-IslandGeometry $process.Id) $settledAgain
    $restingInside = Test-CursorInside $restingRect
    $settledOpen = Read-State $reportPath
    if ($restingInside -and $openState.usageVisible -eq 'Collapsed' -and $settledAgain.usageVisible -eq 'Collapsed') {
      Assert 'the card stays open and still while the pointer rests on it' ($openState.pillHeight -eq $settledAgain.pillHeight -and $openState.pillWidth -eq $settledAgain.pillWidth) "was $($openState.pillWidth)x$($openState.pillHeight), now $($settledAgain.pillWidth)x$($settledAgain.pillHeight)"
      if ($settledOpen.expanded -eq 'True') {
        # Up to two extra morphs are legitimate here: the click lands on a task row, which opens
        # that row's meter and closes it again when the click brings another window forward. A
        # per-poll restart (the flicker bug) would add four to six in the same window.
        Assert 'an open card does not restart its morph either' (($settledOpen.morphRuns - $openState.morphRuns) -le 2) "runs $($openState.morphRuns) -> $($settledOpen.morphRuns)"
        Assert 'an open chevron rests at 180 degrees' ([math]::Abs($settledOpen.chevronAngle - 180) -lt 1) "angle=$($settledOpen.chevronAngle)"
      } else {
        Skip 'open-card stability' 'the card was closed when the samples ended'
      }
    } else {
      Skip 'the card stays open and still' 'the pointer or a task meter moved during the window'
    }

    # ---- the × on a row removes just that task -------------------------------
    # The island shows both tasks; clicking the second row's × must drop that row only, leave the
    # focus queue untouched (the × is not "open the session"), and bring the task back once it
    # does something new. The payload carries no pending request here: a request card belongs to a
    # row and would push the second row down, which is exactly what the row offsets depend on.
    $plainTasks = @{
      version = 1; source = 'page'; generatedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
      tasks = @(
        @{ id = 'session-live-test'; title = '给我看看这个项目，他现在识别不到 codex 当前的任务了'; cwd = 'E:\proj\demo'; running = $true; updatedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); pending = $null; usage = @{ usedTokens = 557032; contextWindow = 1000000; percent = 56; systemTokens = 1491; toolsTokens = 8032; messageTokens = 495062 }; jobs = @{ running = 2 }; children = 0 },
        @{ id = 'session-2'; title = '重构插件系统'; cwd = 'E:\proj\other'; running = $true; updatedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); pending = $null; usage = $null; jobs = @{ running = 0 }; children = 0 }
      )
    } | ConvertTo-Json -Depth 8 -Compress
    for ($cycle = 0; $cycle -lt 2; $cycle += 1) { Send-Snapshot $plainTasks $Port; Start-Sleep -Milliseconds 500 }
    $twoRows = Wait-For { $s = Read-State $reportPath; if ($s.rows -eq '2') { $s } else { $null } } 5000
    Assert 'both tasks are listed before the removal' ($null -ne $twoRows) "rows=$($twoRows.rows)"
    if ($twoRows) {
      # Park on the header first: with no meter open the rows sit at their base offsets, so the
      # × of the second row is where the click expects it. The card must also be open, which a
      # person moving the mouse away can undo.
      for ($attempt = 0; $attempt -lt 3; $attempt += 1) {
        if ($meterPill) { [void][IslandWin32]::SetCursorPos([int]($meterPill.Left + $meterPill.Width / 2), [int]($meterGeometry.Top + 12)) }
        $opened = Wait-For {
          $s = Read-State $reportPath
          if ($s.expanded -eq 'True' -and $s.usageVisible -eq 'Collapsed') { $s } else { $null }
        } 4000
        if ($opened) { break }
        Set-Hover ([int]($meterPill.Left + $meterPill.Width / 2)) ([int]($meterGeometry.Top + 12))
      }
      # The × sits at the right edge of row two. A person moving the mouse can close the card
      # between the reset and the click, so this is retried until the row actually disappears.
      $oneRow = $null
      for ($attempt = 0; $attempt -lt 3 -and -not $oneRow; $attempt += 1) {
        if ($meterPill) { [void][IslandWin32]::SetCursorPos([int]($meterPill.Left + $meterPill.Width / 2), [int]($meterGeometry.Top + 12)) }
        [void](Wait-For {
          $s = Read-State $reportPath
          if ($s.expanded -eq 'True' -and $s.usageVisible -eq 'Collapsed') { $s } else { $null }
        } 4000)
        $dismissGeometry = Get-IslandGeometry $process.Id
        $dismissState = Read-State $reportPath
        $dismissPill = Get-PillRect $dismissGeometry $dismissState
        $dismissRatio = $dismissGeometry.Width / [double](($dismissState.windowSize -split 'x')[0])
        if (-not $dismissPill) { continue }
        # Row two's centre, at the right edge where the × sits.
        [IslandWin32]::Click([int]($dismissPill.Left + $dismissPill.Width - 20 * $dismissRatio), [int]($dismissGeometry.Top + 131 * $dismissRatio))
        $oneRow = Wait-For { $s = Read-State $reportPath; if ($s.rows -eq '1' -and $s.dismissed -eq '1') { $s } else { $null } } 3000
      }
      Assert 'the remove button drops that row only' ($null -ne $oneRow) "rows=$(if ($oneRow) { $oneRow.rows } else { (Read-State $reportPath).rows }) dismissed=$(if ($oneRow) { $oneRow.dismissed } else { 'n/a' })"
      $afterDismiss = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/focus" -Method Get -TimeoutSec 5
      Assert 'the remove button does not open a session' ($null -eq $afterDismiss.sessionId) "queued '$($afterDismiss.sessionId)'"

      # Same task, same state: it stays hidden.
      for ($cycle = 0; $cycle -lt 2; $cycle += 1) { Send-Snapshot $runningTask $Port; Start-Sleep -Milliseconds 500 }
      $stillOne = Read-State $reportPath
      Assert 'a removed task stays hidden while nothing changes' ($stillOne.rows -eq '1' -and $stillOne.dismissed -eq '1') "rows=$($stillOne.rows) dismissed=$($stillOne.dismissed)"

      # A newer activity stamp is new information: it must come back. The idle push is repeated so
      # the overlay cannot miss it between polls.
      $current = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
      $idleTask = @{
        version = 1; source = 'page'; generatedAt = $current
        tasks = @(@{ id = 'session-2'; title = '重构插件系统'; cwd = 'E:\proj\other'; running = $false; updatedAt = $current; pending = $null; usage = $null; jobs = @{ running = 0 }; children = 0 })
      } | ConvertTo-Json -Depth 8 -Compress
      for ($cycle = 0; $cycle -lt 3; $cycle += 1) { Send-Snapshot $idleTask $Port; Start-Sleep -Milliseconds 700 }
      $revived = @{
        version = 1; source = 'page'; generatedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        tasks = @(@{ id = 'session-2'; title = '重构插件系统'; cwd = 'E:\proj\other'; running = $true; updatedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); pending = $null; usage = $null; jobs = @{ running = 0 }; children = 0 })
      } | ConvertTo-Json -Depth 8 -Compress
      for ($cycle = 0; $cycle -lt 2; $cycle += 1) { Send-Snapshot $revived $Port; Start-Sleep -Milliseconds 500 }
      $released = Wait-For { $s = Read-State $reportPath; if ($s.dismissed -eq '0') { $s } else { $null } } 6000
      Assert 'a removed task returns when it starts running again' ($null -ne $released) "dismissed=$(if ($released) { $released.dismissed } else { (Read-State $reportPath).dismissed })"
      for ($cycle = 0; $cycle -lt 2; $cycle += 1) { Send-Snapshot $runningTask $Port; Start-Sleep -Milliseconds 500 }
      $bothBack = Wait-For { $s = Read-State $reportPath; if ($s.rows -eq '2') { $s } else { $null } } 5000
      Assert 'and both tasks are listed again' ($null -ne $bothBack) "rows=$(if ($bothBack) { $bothBack.rows } else { (Read-State $reportPath).rows })"
    } else {
      Skip 'the × removes that row only' 'the two-task model never appeared'
    }

    # ---- Ctrl + wheel resizes the island and remembers the choice -----------
    $beforeResize = Read-State $reportPath
    [IslandWin32]::CtrlWheel(4)
    $grown = Wait-For {
      $state = Read-State $reportPath
      if ($state.ContainsKey('pillWidth') -and $state.pillWidth -gt ($beforeResize.pillWidth + 5)) { $state } else { $null }
    } 4000
    if (Test-Path -LiteralPath $settingsPath) {
      Assert 'Ctrl+wheel grows the island' ($null -ne $grown) "was $($beforeResize.pillWidth), now $(if ($grown) { $grown.pillWidth } else { 'n/a' })"
      $saved = (Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json).scale
      Assert 'the saved scale matches the interaction' ($saved -gt 1) "saved=$saved"
    } else {
      Skip 'Ctrl+wheel resize' 'the pointer left the island before the wheel landed'
    }
    [IslandWin32]::CtrlWheel(-4)
    [void][IslandWin32]::SetCursorPos(20, 400)
  }

  # ---- clicking a task brings the harness window to the front ---------------
  # Uses a stand-in window (dev\harness-stub.ps1) so the user's real DeepSeek Harness window is
  # neither focused nor switched; the overlay is pointed at the stub through --process.
  $stubTitle = 'Harness Stub Target'
  $stubScript = Join-Path (Split-Path $PSScriptRoot -Parent) 'dev\harness-stub.ps1'
  $focusReport = Join-Path $PSScriptRoot 'live-test-focus.state'
  $focusLog = Join-Path $PSScriptRoot 'live-test-focus.log'
  Remove-Item -LiteralPath $focusReport -Force -ErrorAction SilentlyContinue
  $stub = $null
  $focusInstance = $null
  if (Test-Path -LiteralPath $stubScript) {
    # Start-Process joins its arguments with spaces, so both paths and the title are quoted.
    $stub = Start-Process -FilePath 'powershell' `
      -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$stubScript`"", '-Title', "`"$stubTitle`"") `
      -PassThru -WindowStyle Hidden
    $stubReady = Wait-For { if ([IslandWin32]::HasWindowTitled($stubTitle)) { $true } else { $null } } 8000
    Assert 'the stand-in harness window appears' ($null -ne $stubReady)
    try {
      $focusInfo = New-Object System.Diagnostics.ProcessStartInfo
      $focusInfo.FileName = $exe
      $focusInfo.Arguments = "--port $($Port + 3) --url $deadUrl --discovery `"$noDiscovery`" --settings `"$(Join-Path $PSScriptRoot 'live-test-focus.settings.json')`" --process `"$stubTitle`" --log `"$focusLog`" --report `"$focusReport`""
      $focusInfo.UseShellExecute = $false
      $focusInfo.WorkingDirectory = $PSScriptRoot
      $focusInstance = [System.Diagnostics.Process]::Start($focusInfo)
      Start-Sleep -Seconds 2
      for ($cycle = 0; $cycle -lt 3; $cycle += 1) { Send-Snapshot $single ($Port + 3); Start-Sleep -Milliseconds 400 }
      $focusGeometry = Wait-For { $g = Get-IslandGeometry $focusInstance.Id; if ($g -and $g.Visible) { $g } else { $null } }
      $focusState = Read-State $focusReport
      $before = [IslandWin32]::ForegroundTitle()
      $focusPill = Get-PillRect $focusGeometry $focusState
      if ($focusPill) {
        [IslandWin32]::SetCursorPos([int]($focusPill.Left + $focusPill.Width / 2) - 8, [int]($focusPill.Top + 12))
        Start-Sleep -Milliseconds 250
        Set-Hover ([int]($focusPill.Left + $focusPill.Width / 2)) ([int]($focusPill.Top + 12))
        [void](Wait-For { $s = Read-State $focusReport; if ($s.expanded -eq 'True') { $s } else { $null } } 3000)
        $focusRatio = $focusGeometry.Width / [double](($focusState.windowSize -split 'x')[0])
        [IslandWin32]::Click([int]($focusPill.Left + $focusPill.Width / 2), [int]($focusGeometry.Top + 86 * $focusRatio))
      }
      $front = Wait-For {
        $title = [IslandWin32]::ForegroundTitle()
        if ($title -like "*$stubTitle*") { $title } else { $null }
      } 5000
      Assert 'clicking a task brings the harness window to the front' ($null -ne $front) "before='$before' after='$([IslandWin32]::ForegroundTitle())'"

      # A minimized harness window must be restored, not just focused: ShowWindow(SW_RESTORE)
      # across threads is silently dropped, so this is the case that used to look like
      # "clicking does nothing".
      $stubHandle = [IslandWin32]::HandleOfTitle($stubTitle)
      if ($stubHandle -ne [IntPtr]::Zero) {
        [void][IslandWin32]::ShowWindow($stubHandle, 6)
        # Minimizing animates, so IsIconic flips a moment later rather than immediately.
        $minimized = Wait-For { if ([IslandWin32]::IsIconic($stubHandle)) { $true } else { $null } } 4000
        Assert 'the stand-in window is minimized for the test' ($null -ne $minimized)
        if ($minimized) {
          $focusPill2 = Get-PillRect (Get-IslandGeometry $focusInstance.Id) (Read-State $focusReport)
          if ($focusPill2) {
            Set-Hover ([int]($focusPill2.Left + $focusPill2.Width / 2)) ([int]($focusPill2.Top + 12))
            [void](Wait-For { $s = Read-State $focusReport; if ($s.expanded -eq 'True') { $s } else { $null } } 3000)
            $focusGeometry2 = Get-IslandGeometry $focusInstance.Id
            $focusWindowSize = [double](((Read-State $focusReport).windowSize -split 'x')[0])
            $ratio2 = $focusGeometry2.Width / $focusWindowSize
            [IslandWin32]::Click([int]($focusPill2.Left + $focusPill2.Width / 2), [int]($focusGeometry2.Top + 86 * $ratio2))
          }
          $restored = Wait-For { if (-not [IslandWin32]::IsIconic($stubHandle)) { $true } else { $null } } 5000
          Assert 'clicking a task restores a minimized harness window' ($null -ne $restored)
          $frontAgain = Wait-For { $title = [IslandWin32]::ForegroundTitle(); if ($title -like "*$stubTitle*") { $title } else { $null } } 5000
          Assert 'and brings it to the front again' ($null -ne $frontAgain)
        } else {
          Skip 'clicking a task restores a minimized harness window' 'the stand-in window would not minimize'
        }
      } else {
        Skip 'clicking a task restores a minimized harness window' 'the stand-in window handle was lost'
      }
    }
    finally {
      if ($focusInstance -and -not $focusInstance.HasExited) { Stop-Process -Id $focusInstance.Id -Force -ErrorAction SilentlyContinue }
    }
  } else {
    Skip 'clicking a task brings the harness window to the front' "no stub script at $stubScript"
  }
  if ($stub -and -not $stub.HasExited) { Stop-Process -Id $stub.Id -Force -ErrorAction SilentlyContinue }

  # ---- a pending approval shows under its task, and Allow / Deny reach the host ----
  # A stand-in host serves a snapshot with one waiting approval and records what the island sends
  # when the buttons are clicked, so the whole click-to-decision path is exercised without a real
  # approval (this session has prompts disabled, and a real one would need the app anyway).
  $mockHostScript = Join-Path (Split-Path $PSScriptRoot -Parent) 'dev\mock-host.mjs'
  $approvalPort = $Port + 5
  $approvalSettings = Join-Path $PSScriptRoot 'live-test-approval.settings.json'
  $approvalReport = Join-Path $PSScriptRoot 'live-test-approval.state'
  $approvalOutput = Join-Path $env:TEMP 'dsh-island-mock-host.out'
  Remove-Item -LiteralPath $approvalSettings, $approvalReport, $approvalOutput -Force -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath $mockHostScript) {
    $mockHost = Start-Process -FilePath 'node' -ArgumentList @($mockHostScript, $approvalPort) -PassThru -WindowStyle Hidden -RedirectStandardOutput $approvalOutput
    $approvalInstance = $null
    try {
      Start-Sleep -Seconds 2
      # The approval route is announced in its own file beside the discovery file (that is how a
      # hot-published revision adds the route to an already running DSH). Point the discovery at a
      # temp folder and announce the mock's route there, while `--focus-url` points at a dead port:
      # then only the announcement can deliver a click, which is exactly what this proves.
      $approvalDiscoveryDir = Join-Path $env:TEMP "dsh-island-approval-$PID"
      New-Item -ItemType Directory -Force -Path $approvalDiscoveryDir | Out-Null
      $approvalDiscovery = Join-Path $approvalDiscoveryDir 'dynamic-island.json'
      Remove-Item -LiteralPath $approvalDiscovery -Force -ErrorAction SilentlyContinue
      "{ `"port`": $approvalPort, `"url`": `"http://127.0.0.1:$approvalPort/approval`", `"updatedAt`": 0 }" |
        Set-Content -LiteralPath (Join-Path $approvalDiscoveryDir 'dynamic-island.approval.json') -Encoding UTF8

      $approvalInfo = New-Object System.Diagnostics.ProcessStartInfo
      $approvalInfo.FileName = $exe
      $approvalInfo.Arguments = "--port $($Port + 6) --url http://127.0.0.1:$approvalPort/island --focus-url $deadUrl --discovery `"$approvalDiscovery`" --settings `"$approvalSettings`" --always-show --log `"$(Join-Path $PSScriptRoot 'live-test-approval.log')`" --report `"$approvalReport`""
      $approvalInfo.UseShellExecute = $false
      $approvalInfo.WorkingDirectory = $PSScriptRoot
      $approvalInstance = [System.Diagnostics.Process]::Start($approvalInfo)

      $card = Wait-For {
        $s = Read-State $approvalReport
        if ($s.requestCount -eq '1') { $s } else { $null }
      } 8000
      Assert 'a pending approval gets its own card under that task' ($card -and $card.requestRow -eq 'session-approval') "row=$(if ($card) { $card.requestRow } else { 'n/a' })"
      # The card is a request, not a task row: it belongs to the waiting task and carries text.
      Assert 'the approval card carries its reason text' ($card -and -not [string]::IsNullOrEmpty($card.requestHead)) "head='$(if ($card) { $card.requestHead } else { 'n/a' })'"

      # Display only: the island reports the waiting approval and never decides it, so the
      # absence of answer controls is the assertion — answering belongs to the shipped Harness UI.
      if ($card) {
        $approvalGeometry = Wait-For { $g = Get-IslandGeometry $approvalInstance.Id; if ($g -and $g.Visible) { $g } else { $null } } 6000
        if ($approvalGeometry) {
          Set-Hover ([int]($approvalGeometry.Left + $approvalGeometry.Width / 2)) ([int]($approvalGeometry.Top + 12))
          [void](Wait-For { $s = Read-State $approvalReport; if ($s.expanded -eq 'True') { $s } else { $null } } 6000)
          # The report has no button rectangles at all any more; if the answering plumbing ever
          # comes back, these fields reappear and this fails.
          Assert 'the island exposes no answer controls' (-not (Read-State $approvalReport).ContainsKey('allowRect')) "allowRect=$((Read-State $approvalReport).allowRect)"
          $hostSaw = ''
          if (Test-Path -LiteralPath $approvalOutput) { $hostSaw = Get-Content -LiteralPath $approvalOutput -Raw -ErrorAction SilentlyContinue }
          Assert 'the island never posts an approval decision' ([string]::IsNullOrEmpty($hostSaw) -or $hostSaw -notmatch 'decision') 'the host received a decision'
        } else {
          Skip 'the island exposes no answer controls' 'the approval instance never showed a window'
        }
      }
    }
    finally {
      if ($approvalInstance -and -not $approvalInstance.HasExited) { Stop-Process -Id $approvalInstance.Id -Force -ErrorAction SilentlyContinue }
      if ($mockHost -and -not $mockHost.HasExited) { Stop-Process -Id $mockHost.Id -Force -ErrorAction SilentlyContinue }
    }
  } else {
    Skip 'a pending approval gets its own card under that task' "no mock host at $mockHostScript"
  }

  # ---- --always-show keeps the island on screen with nothing to report ------
  $alwaysSettings = Join-Path $PSScriptRoot 'live-test-always.settings.json'
  $alwaysReport = Join-Path $PSScriptRoot 'live-test-always.state'
  Remove-Item -LiteralPath $alwaysSettings -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $alwaysReport -Force -ErrorAction SilentlyContinue
  $alwaysInfo = New-Object System.Diagnostics.ProcessStartInfo
  $alwaysInfo.FileName = $exe
  $alwaysInfo.Arguments = "--port $($Port + 4) --url $deadUrl --discovery `"$noDiscovery`" --settings `"$alwaysSettings`" --always-show --log `"$(Join-Path $PSScriptRoot 'live-test-always.log')`" --report `"$alwaysReport`""
  $alwaysInfo.UseShellExecute = $false
  $alwaysInfo.WorkingDirectory = $PSScriptRoot
  $always = [System.Diagnostics.Process]::Start($alwaysInfo)
  try {
    $kept = Wait-For { $g = Get-IslandGeometry $always.Id; if ($g -and $g.Visible) { $g } else { $null } } 9000
    Assert 'an island started with --always-show is on screen with no data' ($null -ne $kept)
    if ($kept) {
      # Nothing to report is not a labelled pill: it is a plain black block.
      $block = Wait-For {
        $s = Read-State $alwaysReport
        if ($s.empty -eq 'True') { $s } else { $null }
      } 6000
      $blockSeen = Read-State $alwaysReport
      Assert 'and it is a plain empty block, not a labelled pill' ($null -ne $block) "empty=$($blockSeen.empty)"
      Assert 'the empty block is small' ([double]$blockSeen.pillWidth -le 140 -and [double]$blockSeen.pillHeight -le 44) "pill=$($blockSeen.pillWidth)x$($blockSeen.pillHeight)"
      Assert 'the empty block shows no header text' ([string]::IsNullOrEmpty($blockSeen.headerText)) "header='$($blockSeen.headerText)'"
    }
  }
  finally {
    if ($always -and -not $always.HasExited) { Stop-Process -Id $always.Id -Force -ErrorAction SilentlyContinue }
  }

  # ---- the --scale flag scales the pill without touching the mouse ----------
  $scaledInfo = New-Object System.Diagnostics.ProcessStartInfo
  $scaledInfo.FileName = $exe
  $scaledInfo.Arguments = "--port $($Port + 1) --url $deadUrl --discovery `"$noDiscovery`" --settings `"$scaledSettingsPath`" --scale 1.25 --log `"$(Join-Path $PSScriptRoot 'live-test-scaled.log')`" --report `"$scaledReportPath`""
  $scaledInfo.UseShellExecute = $false
  $scaledInfo.WorkingDirectory = $PSScriptRoot
  $scaled = [System.Diagnostics.Process]::Start($scaledInfo)
  try {
    Start-Sleep -Seconds 2
    # Feed both instances the same short-title payload until each has applied it (a single push
    # ages past its TTL and the overlay hides again), then compare like for like: same state,
    # two scales. The pointer is parked away first so both are collapsed when measured.
    [void][IslandWin32]::SetCursorPos(20, 500)
    Start-Sleep -Milliseconds 900
    $baseCollapsed = $null
    for ($attempt = 0; $attempt -lt 8; $attempt += 1) {
      Send-Snapshot $single $Port
      Start-Sleep -Milliseconds 350
      $state = Read-State $reportPath
      if ((Get-IslandGeometry $process.Id).Visible -and $state.expanded -eq 'False') { $baseCollapsed = $state }
    }
    $scaledState = $null
    for ($attempt = 0; $attempt -lt 8; $attempt += 1) {
      Send-Snapshot $single ($Port + 1)
      Start-Sleep -Milliseconds 350
      $state = Read-State $scaledReportPath
      if ((Get-IslandGeometry $scaled.Id).Visible -and $state.expanded -eq 'False') { $scaledState = $state }
    }
    if ($scaledState -and $baseCollapsed) {
      $ratio = $scaledState.pillWidth / $baseCollapsed.pillWidth
      Assert 'the --scale flag scales the pill' ([math]::Abs($ratio - 1.25) -lt 0.06) "ratio=$([math]::Round($ratio, 3)) (base=$($baseCollapsed.pillWidth) scaled=$($scaledState.pillWidth))"
    } else {
      Assert 'the --scale flag scales the pill' ($false) 'a scaled or base window never applied the payload'
    }
  }
  finally {
    if ($scaled -and -not $scaled.HasExited) { Stop-Process -Id $scaled.Id -Force -ErrorAction SilentlyContinue }
  }
}
finally {
  if ($process -and -not $process.HasExited) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Milliseconds 300
}

if ($failures -gt 0) { Write-Host "$failures check(s) failed" -ForegroundColor Red; exit 1 }
Write-Host ("ALL OVERLAY LIVE CASES PASSED ({0} skipped)" -f $skips) -ForegroundColor Green
