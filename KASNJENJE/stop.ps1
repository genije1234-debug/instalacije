$ErrorActionPreference = "SilentlyContinue"

# --- Self-elevate (admin je potreban da bismo mogli da ugasimo sve procese) ---
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
$pidsFile = Join-Path $root ".pids.json"

$scripts = @("bwin-live.mjs", "admiral-football.mjs", "compare-3202.mjs")
$ports   = @(3200, 3201, 3202)
$killed  = @()

function Stop-ByPid {
  param([Parameter(Mandatory = $true)][int]$TargetPid)
  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$TargetPid"
  if ($null -eq $p) { return $false }
  taskkill /F /PID $TargetPid | Out-Null
  return $true
}

function Stop-ByScriptFallback {
  param([Parameter(Mandatory = $true)][string]$ScriptName)
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object {
      $cmd = $_.CommandLine
      if ($null -eq $cmd) { return $false }
      $cmd.ToLower().Contains($ScriptName.ToLower())
    } |
    ForEach-Object {
      taskkill /F /PID $_.ProcessId | Out-Null
      $script:killed += $_.ProcessId
      Write-Host "[stop:node] $ScriptName PID=$($_.ProcessId)"
    }
}

function Stop-PortOwners {
  param([Parameter(Mandatory = $true)][int[]]$Ports)
  $ownerPids = @()
  foreach ($port in $Ports) {
    $listeners = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    if ($listeners) {
      $ownerPids += ($listeners | Select-Object -ExpandProperty OwningProcess)
    }
  }
  $ownerPids = $ownerPids | Where-Object { $_ -gt 0 } | Select-Object -Unique
  foreach ($procId in $ownerPids) {
    taskkill /F /PID $procId | Out-Null
    $script:killed += [int]$procId
    Write-Host "[stop:port] PID=$procId"
  }
}

# Gasi SVE Chrome/Edge prozore koje je KASNJENJE otvorio:
#  - UI prozor (profil kasnjenje-ui)
#  - puppeteer automation Chrome (profil chrome-bwin-live)
# Oba imaju KASNJENJE putanju u komandnoj liniji, pa ne diramo obican browser.
function Stop-KasnjenjeBrowsers {
  param([Parameter(Mandatory = $true)][string]$RootPath)
  $rootNorm = $RootPath.ToLower()
  Get-CimInstance Win32_Process |
    Where-Object {
      ($_.Name -eq "chrome.exe" -or $_.Name -eq "msedge.exe") -and
      $_.CommandLine -and
      $_.CommandLine.ToLower().Contains($rootNorm)
    } |
    ForEach-Object {
      taskkill /F /PID $_.ProcessId | Out-Null
      $script:killed += [int]$_.ProcessId
      Write-Host "[stop:browser] $($_.Name) PID=$($_.ProcessId)"
    }
}

# 1) Gasi node po zapamcenim PID-ovima
if (Test-Path $pidsFile) {
  try {
    $data = Get-Content $pidsFile -Raw | ConvertFrom-Json
    foreach ($script in $scripts) {
      $pidProp = $data.pids.PSObject.Properties[$script]
      $trackedPid = $null
      if ($null -ne $pidProp) { $trackedPid = $pidProp.Value }
      if ($null -ne $trackedPid -and ($trackedPid -as [int]) -gt 0) {
        if (Stop-ByPid -TargetPid ([int]$trackedPid)) {
          $killed += [int]$trackedPid
          Write-Host "[stop:pids] $script PID=$trackedPid"
        }
      }
    }
  } catch {
    Write-Host "[warn] .pids.json nije validan, prelazim na fallback."
  }
}

# 2) Fallback: gasi node po imenu skripte
foreach ($script in $scripts) {
  Stop-ByScriptFallback -ScriptName $script
}

# 3) Gasi sve sto jos drzi portove
Stop-PortOwners -Ports $ports

# 4) Gasi KASNJENJE browser prozore (UI + automation)
Stop-KasnjenjeBrowsers -RootPath $root

# 5) Obrisi PID fajl
if (Test-Path $pidsFile) {
  Remove-Item $pidsFile -Force
}

# 6) Provera
foreach ($p in $ports) {
  $listener = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue
  if ($listener) { Write-Host "[warn] port $p i dalje slusa (PID $($listener.OwningProcess))" }
  else { Write-Host "[ok] port $p free" }
}

Write-Host "Zaustavljen KASNJENJE. Ugaseno procesa: $($killed.Count)"
