@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-and-start.ps1"
set "result=%errorlevel%"
if not "%result%"=="0" (
  echo.
  echo Build or launch failed. See the error above.
  pause
)
endlocal & exit /b %result%
