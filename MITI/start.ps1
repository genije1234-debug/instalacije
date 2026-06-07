$ErrorActionPreference = "Stop"

# --- Self-elevate (admin je potreban da bismo mogli da ugasimo stare procese) ---
$self = $MyInvocation.MyCommand.Path
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Start-Process powershell -Verb RunAs -ArgumentList @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", "`"$self`""
  ) | Out-Null
  exit
}

$root       = Split-Path -Parent $MyInvocation.MyCommand.Path
$pidsFile   = Join-Path $root ".pids.json"
$stopScript = Join-Path $root "stop.ps1"
$uiProfile  = Join-Path $root "miti-ui"

$services = @(
  @{ Name = "4001 (esoccer-skupljac)"; Arg = (Join-Path $root "esoccer-skupljac\server.js"); WorkDir = (Join-Path $root "esoccer-skupljac"); Match = "esoccer-skupljac\server.js"; Port = 4001; Health = "http://localhost:4001/state" },
  @{ Name = "3000 (admiral-web)";      Arg = (Join-Path $root "admiral-web.mjs");           WorkDir = $root;                          Match = "admiral-web.mjs";                Port = 3000; Health = "http://localhost:3000/api/data" },
  @{ Name = "3007 (esoccer-1x2)";      Arg = (Join-Path $root "esoccer-1x2.mjs");           WorkDir = $root;                          Match = "esoccer-1x2.mjs";                Port = 3007; Health = "http://localhost:3007/state" },
  @{ Name = "3008 (sve-surebets)";     Arg = (Join-Path $root "sve-surebets.mjs");          WorkDir = $root;                          Match = "sve-surebets.mjs";               Port = 3008; Health = "http://localhost:3008/data" },
  @{ Name = "4003 (surebets-4003)";    Arg = (Join-Path $root "surebets-4003.mjs");         WorkDir = $root;                          Match = "surebets-4003.mjs";              Port = 4003; Health = "http://localhost:4003/data" },
  @{ Name = "4005 (surebets-4005)";    Arg = (Join-Path $root "surebets-4005.mjs");         WorkDir = $root;                          Match = "surebets-4005.mjs";              Port = 4005; Health = "http://localhost:4005/data" }
)

# Sve stranice u JEDNOM prozoru (tabovi)
$uiUrls = @(
  "http://localhost:3000/",
  "http://localhost:3007/",
  "http://localhost:3008/",
  "http://localhost:4001/",
  "http://localhost:4003/",
  "http://localhost:4005/"
)

function Test-Endpoint {
  param(
    [Parameter(Mandatory = $true)][string]$Url,
    [int]$TimeoutSec = 3
  )
  try {
    $null = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec $TimeoutSec
    return $true
  } catch {
    return $false
  }
}

function Wait-Endpoint {
  param(
    [Parameter(Mandatory = $true)][string]$Url,
    [int]$TimeoutSec = 50
  )
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  while ($sw.Elapsed.TotalSeconds -lt $TimeoutSec) {
    if (Test-Endpoint -Url $Url -TimeoutSec 3) { return $true }
    Start-Sleep -Milliseconds 500
  }
  return $false
}

function Wait-PortsFree {
  param(
    [Parameter(Mandatory = $true)][int[]]$Ports,
    [int]$TimeoutSec = 12
  )
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  while ($sw.Elapsed.TotalSeconds -lt $TimeoutSec) {
    $busy = @()
    foreach ($p in $Ports) {
      $listener = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue
      if ($listener) { $busy += $p }
    }
    if ($busy.Count -eq 0) { return $true }
    Start-Sleep -Milliseconds 500
  }
  return $false
}

function Get-BrowserExe {
  $candidates = @(
    "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    "C:\Program Files\Google\Chrome\Application\chrome.exe",
    "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    "C:\Program Files\Microsoft\Edge\Application\msedge.exe"
  )
  foreach ($p in $candidates) {
    if (Test-Path $p) { return $p }
  }
  return $null
}

function Open-MitiWindow {
  $browserExe = Get-BrowserExe
  if ($browserExe) {
    $args = @(
      "--no-first-run",
      "--no-default-browser-check",
      "--new-window",
      "--user-data-dir=$uiProfile"
    ) + $uiUrls
    Start-Process -FilePath $browserExe -ArgumentList $args | Out-Null
    Write-Host "[ui] Otvoren jedan prozor sa svim stranicama."
  } else {
    foreach ($u in $uiUrls) { Start-Process $u | Out-Null }
    Write-Host "[ui] Browser nije pronadjen - otvoreno u podrazumevanom browseru."
  }
}

Set-Location $root
$started = @()
$pidMap  = @{}
$ports   = $services | ForEach-Object { [int]$_.Port }

# 1) Ocisti sve staro (servere + stare MITI browser prozore)
if (Test-Path $stopScript) {
  Write-Host "[prep] Ciscenje starih procesa..."
  & powershell -NoProfile -ExecutionPolicy Bypass -File $stopScript
}

if (-not (Wait-PortsFree -Ports $ports -TimeoutSec 12)) {
  throw "Portovi se nisu oslobodili posle ciscenja. Probaj jos jednom STOP pa POKRENI."
}

# 2) Pokreni servise redom
foreach ($svc in $services) {
  $name   = $svc.Name
  $arg    = $svc.Arg
  $work   = $svc.WorkDir
  $match  = $svc.Match
  $health = $svc.Health

  Write-Host "[start] $name"
  $p = Start-Process node -WorkingDirectory $work -ArgumentList "`"$arg`"" -PassThru -WindowStyle Minimized
  $pidMap[$match] = $p.Id

  if (-not (Wait-Endpoint -Url $health -TimeoutSec 50)) {
    throw "$name nije postao dostupan posle starta."
  }
  $started += $name
}

# 3) Zapamti PID-ove
$payload = [pscustomobject]@{
  startedAt = (Get-Date).ToString("o")
  root      = $root
  pids      = $pidMap
}
$payload | ConvertTo-Json -Depth 5 | Set-Content -Path $pidsFile -Encoding UTF8

Write-Host ""
Write-Host "MITI pokrenut:"
Write-Host " - startovani: $($started.Count)"
Write-Host " - 3000: http://localhost:3000/"
Write-Host " - 3007: http://localhost:3007/"
Write-Host " - 3008: http://localhost:3008/"
Write-Host " - 4001: http://localhost:4001/"
Write-Host " - 4003: http://localhost:4003/"
Write-Host " - 4005: http://localhost:4005/"

# 4) Otvori sve odjednom (jedan prozor, svi tabovi)
Open-MitiWindow
