@echo off
setlocal
cd /d "%~dp0"

echo Pokrecem KASNJENJE (admin)...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File ""%~dp0start.ps1""'"

endlocal
