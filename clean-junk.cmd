@echo off
rem clean-junk.cmd - double-click entry for tools\clean-junk.ps1
rem   no args  : preview only, nothing is deleted
rem   -Apply   : delete the default set (moved to the Recycle Bin)
rem   -IncludeShots : also remove the smoke screenshots in shots\
rem ASCII only on purpose: cmd reads these bytes in the OEM code page.

setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\clean-junk.ps1" %*
echo.
echo Done. Press any key to close this window.
pause >nul
