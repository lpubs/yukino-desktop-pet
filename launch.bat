@echo off
rem ===== Yukino Desktop Pet launcher =====
rem %~dp0 = the folder this script lives in (with trailing backslash).
rem No machine-specific paths are hardcoded here.
cd /d "%~dp0"
set ELECTRON_RUN_AS_NODE=
if not exist "%~dp0node_modules\electron\dist\electron.exe" (
  echo [ERROR] Electron not installed.
  echo Run this first:  cd /d "%~dp0" ^&^& npm install
  pause
  exit /b 1
)
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0"
exit
