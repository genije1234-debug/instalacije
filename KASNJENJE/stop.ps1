$ErrorActionPreference = "SilentlyContinue"

Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object {
    $cmd = $_.CommandLine
    $cmd -like "*bwin-live.mjs*" -or
    $cmd -like "*admiral-football.mjs*" -or
    $cmd -like "*compare-3202.mjs*"
  } |
  ForEach-Object {
    Write-Host "Stopping PID $($_.ProcessId)"
    taskkill /F /PID $_.ProcessId | Out-Null
  }

Write-Host "Stopped KASNJENJE processes."
