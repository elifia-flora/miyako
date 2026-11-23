@echo off
rem Double-click entry for tools\fix-integrity.mjs.
rem
rem Why: DSH's workspace-write sandbox labels the project folder "Low" and
rem Electron 44 / Chromium 152 refuses to start from a low-integrity folder
rem (window closes instantly, exit code 0x80000003, no logs/boot.log at all).
rem Switching back to full access does NOT remove the label; this script does.
rem
rem ASCII-only on purpose: cmd.exe reads these bytes in the OEM code page.
rem chcp 65001 below is only for the Node output (which is UTF-8).

chcp 65001 >nul
setlocal
cd /d "%~dp0.."

where node >nul 2>nul
if errorlevel 1 (
  echo [music-atlas] Node.js was not found in PATH.
  pause
  exit /b 1
)

node "tools\fix-integrity.mjs"
set "RC=%ERRORLEVEL%"
echo.
if not "%RC%"=="0" (
  echo [music-atlas] Could not repair the Low integrity label.
  echo   Run this file from a normal desktop window ^(outside DSH^), and make sure
  echo   your account owns the project folder.
) else (
  echo [music-atlas] Done. You can start the app now.
)
pause
