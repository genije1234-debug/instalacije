@echo off
setlocal
cd /d "%~dp0"

echo Gasim MITI (admin)...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File ""%~dp0stop.ps1""'"

endlocal
