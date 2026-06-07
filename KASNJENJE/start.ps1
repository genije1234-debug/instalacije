$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host "Starting 3200 (bwin-live)..."
Start-Process node -WorkingDirectory $root -ArgumentList "bwin-live.mjs"
Start-Sleep -Seconds 2

Write-Host "Starting 3201 (admiral-football)..."
Start-Process node -WorkingDirectory $root -ArgumentList "admiral-football.mjs"
Start-Sleep -Seconds 2

Write-Host "Starting 3202 (compare)..."
Start-Process node -WorkingDirectory $root -ArgumentList "compare-3202.mjs"
Start-Sleep -Seconds 2

Write-Host ""
Write-Host "KASNJENJE pokrenut:"
Write-Host " - 3200: http://localhost:3200/"
Write-Host " - 3201: http://localhost:3201/api"
Write-Host " - 3202: http://localhost:3202/"
