@echo off
rem Stops the desktop Dynamic Island overlay.
taskkill /IM DynamicIsland.exe /F >nul 2>&1
if errorlevel 1 (
  echo The island was not running.
  exit /b 0
)
echo Dynamic Island stopped.
