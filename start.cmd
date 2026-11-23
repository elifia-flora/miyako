@echo off
setlocal
cd /d "%~dp0"

rem Keep this file ASCII-only: cmd.exe reads .cmd in the OEM code page,
rem so non-ASCII comments can corrupt the script on some machines.

rem Editors/terminals often inject ELECTRON_RUN_AS_NODE=1. If it leaks in,
rem electron.exe degrades into plain Node and fails with "whenReady of undefined".
set ELECTRON_RUN_AS_NODE=

rem DSH's workspace-write sandbox can label this folder "Low"; Electron 44's
rem browser-process sandbox refuses to start from such a folder (instant exit,
rem 0x80000003, no logs\boot.log). Switching to full access does NOT remove an
rem existing label, so repair it here when needed. Quiet when everything is OK.
rem Use the absolute where.exe: an MSYS/Git "where" on PATH is a different tool.
"%SystemRoot%\System32\where.exe" node >nul 2>&1
if not errorlevel 1 (
  if exist "tools\fix-integrity.mjs" (
    node "tools\fix-integrity.mjs" --quiet >nul 2>&1
    if errorlevel 1 (
      echo.
      echo [music-atlas] Workspace integrity is Low and could not be repaired.
      echo   Double-click tools\fix-integrity.cmd, then start the app again.
      pause
      exit /b 1
    )
  )
)

rem Always use absolute paths for Windows tools. When this script is launched from
rem a shell whose PATH contains Git/MSYS tools, bare "find" resolves to GNU find,
rem and "ping" can be shadowed too.
set "SYS=%SystemRoot%\System32"
set "FINDSTR=%SYS%\findstr.exe"
set "TASKLIST=%SYS%\tasklist.exe"
set "PING=%SYS%\ping.exe"

if not exist "node_modules\electron\dist\electron.exe" (
  echo [music-atlas] electron is missing. Run: npm install
  pause
  exit /b 1
)

if not exist "out\main\index.js" (
  echo [music-atlas] first run: building...
  call npx electron-vite build
  if errorlevel 1 (
    echo [music-atlas] build failed, see the output above.
    pause
    exit /b 1
  )
)

rem Use "%~dp0." (trailing dot): %~dp0 already ends with a backslash, and
rem passing "%~dp0" as an argument makes the closing quote escape the path.
set "EXE=%~dp0node_modules\electron\dist\electron.exe"
set "APPDIR=%~dp0."

rem Already running? The single-instance lock will just bring it to front, and
rem that path writes no logs/boot.log - so skip the health check entirely.
tasklist /fi "IMAGENAME eq electron.exe" 2>nul | "%FINDSTR%" /i "electron.exe" >nul
if not errorlevel 1 (
  start "" "%EXE%" "%APPDIR%"
  exit /b 0
)

if not exist "logs" mkdir "logs"
if exist "logs\boot.log" del /q "logs\boot.log"
start "" "%EXE%" "%APPDIR%"

rem A double-click window closes the moment this script ends, so a crash would
rem look like "nothing happened". Wait ~3s and check the app got as far as
rem showing its window; if not, surface logs\boot.log and keep the window open.
"%PING%" -n 4 127.0.0.1 >nul
"%FINDSTR%" /c:"shown visible=true" "logs\boot.log" >nul 2>&1
if errorlevel 1 (
  echo.
  echo [music-atlas] startup failed - window never appeared.
  echo ------------------------------------------------------------
  if exist "logs\boot.log" (
    type "logs\boot.log"
  ) else (
    echo No logs\boot.log at all: the process died before main process code ran.
    echo Run it directly to see the error:
    echo   "%EXE%" "%APPDIR%"
  )
  echo ------------------------------------------------------------
  pause
)
endlocal
