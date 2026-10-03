@echo off
rem Starts the desktop Dynamic Island overlay detached (no console window).
rem The Harness page finds it by probing 127.0.0.1:19391-19395 and pushes its tasks.
rem --always-show keeps a resting pill while DSH is active; --hide-on-disconnect hides it after
rem DSH exits, while leaving the overlay ready to recover when DSH starts again.
setlocal
set "EXE=%~dp0DynamicIsland.exe"
if not exist "%EXE%" (
  echo DynamicIsland.exe is missing - run: powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build.ps1"
  exit /b 1
)
tasklist /FI "IMAGENAME eq DynamicIsland.exe" 2>nul | find /I "DynamicIsland.exe" >nul
if not errorlevel 1 (
  echo The island is already running.
  exit /b 0
)
start "" "%EXE%" --log "%~dp0island.log" --report "%~dp0island.state.txt" --always-show --hide-on-disconnect
echo Dynamic Island started.
endlocal
