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

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$pidsFile  = Join-Path $root ".pids.json"
$stopScript = Join-Path $root "stop.ps1"
$uiProfile = Join-Path $root "kasnjenje-ui"

$services = @(
  @{ Name = "3200 (bwin-live)";        Script = "bwin-live.mjs";        Port = 3200; Health = "http://localhost:3200/data" },
  @{ Name = "3201 (admiral-football)"; Script = "admiral-football.mjs"; Port = 3201; Health = "http://localhost:3201/api" },
  @{ Name = "3202 (compare)";          Script = "compare-3202.mjs";     Port = 3202; Health = "http://localhost:3202/" }
)

# Redosled tabova koji se otvaraju (sve u JEDNOM prozoru)
$uiUrls = @(
  "http://localhost:3201/",
  "http://localhost:3202/",
  "http://localhost:3200/"
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
    [int]$TimeoutSec = 10
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

function Open-KasnjenjeWindow {
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

# 1) Ocisti sve staro (servere + stare KASNJENJE browser prozore)
if (Test-Path $stopScript) {
  Write-Host "[prep] Ciscenje starih procesa..."
  & powershell -NoProfile -ExecutionPolicy Bypass -File $stopScript
}

if (-not (Wait-PortsFree -Ports $ports -TimeoutSec 10)) {
  throw "Portovi se nisu oslobodili posle ciscenja. Probaj jos jednom STOP pa START."
}

# 2) Pokreni sva tri servisa jednom
foreach ($svc in $services) {
  $name   = $svc.Name
  $script = $svc.Script
  $health = $svc.Health

  Write-Host "[start] $name"
  $p = Start-Process node -WorkingDirectory $root -ArgumentList $script -PassThru -WindowStyle Minimized
  $pidMap[$script] = $p.Id

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
Write-Host "KASNJENJE pokrenut:"
Write-Host " - startovani: $($started.Count)"
Write-Host " - 3200: http://localhost:3200/"
Write-Host " - 3201: http://localhost:3201/api"
Write-Host " - 3202: http://localhost:3202/"

# 4) Otvori sve odjednom (jedan prozor, tri taba)
Open-KasnjenjeWindow
