@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-and-start.ps1" %*
set "result=%errorlevel%"

if not "%result%"=="0" (
  echo.
  echo Build or launch failed.
  echo Please upload the newest log from:
  echo %~dp0artifacts\local-build\
  pause
)

endlocal & exit %result%
