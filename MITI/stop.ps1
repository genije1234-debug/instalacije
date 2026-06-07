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

# Identifikatori node skripti (substring u komandnoj liniji)
$scripts = @(
  "esoccer-skupljac\server.js",
  "admiral-web.mjs",
  "esoccer-1x2.mjs",
  "sve-surebets.mjs",
  "surebets-4003.mjs",
  "surebets-4005.mjs"
)
$ports  = @(3000, 3007, 3008, 4001, 4003, 4005)
$killed = @()

# Tree-kill: gasi proces I svu njegovu decu (puppeteer/playwright Chrome itd.)
function Stop-Tree {
  param([Parameter(Mandatory = $true)][int]$TargetPid)
  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$TargetPid"
  if ($null -eq $p) { return $false }
  taskkill /F /T /PID $TargetPid | Out-Null
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
      taskkill /F /T /PID $_.ProcessId | Out-Null
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
    taskkill /F /T /PID $procId | Out-Null
    $script:killed += [int]$procId
    Write-Host "[stop:port] PID=$procId"
  }
}

# Gasi samo MITI UI prozor (zaseban profil miti-ui) - ne dira obican browser.
function Stop-MitiUiBrowser {
  param([Parameter(Mandatory = $true)][string]$ProfileDir)
  $needle = $ProfileDir.ToLower()
  Get-CimInstance Win32_Process |
    Where-Object {
      ($_.Name -eq "chrome.exe" -or $_.Name -eq "msedge.exe") -and
      $_.CommandLine -and
      $_.CommandLine.ToLower().Contains($needle)
    } |
    ForEach-Object {
      taskkill /F /PID $_.ProcessId | Out-Null
      $script:killed += [int]$_.ProcessId
      Write-Host "[stop:browser] $($_.Name) PID=$($_.ProcessId)"
    }
}

# 1) Gasi node po zapamcenim PID-ovima (tree-kill -> pada i njihov Chrome)
if (Test-Path $pidsFile) {
  try {
    $data = Get-Content $pidsFile -Raw | ConvertFrom-Json
    foreach ($prop in $data.pids.PSObject.Properties) {
      $trackedPid = $prop.Value
      if ($null -ne $trackedPid -and ($trackedPid -as [int]) -gt 0) {
        if (Stop-Tree -TargetPid ([int]$trackedPid)) {
          $killed += [int]$trackedPid
          Write-Host "[stop:pids] $($prop.Name) PID=$trackedPid"
        }
      }
    }
  } catch {
    Write-Host "[warn] .pids.json nije validan, prelazim na fallback."
  }
}

# 2) Fallback: gasi node po imenu skripte (tree-kill)
foreach ($script in $scripts) {
  Stop-ByScriptFallback -ScriptName $script
}

# 3) Gasi sve sto jos drzi portove (tree-kill)
Stop-PortOwners -Ports $ports

# 4) Gasi MITI UI prozor (profil miti-ui)
Stop-MitiUiBrowser -ProfileDir (Join-Path $root "miti-ui")

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

Write-Host "Zaustavljen MITI. Ugaseno procesa: $($killed.Count)"
Write-Host "NAPOMENA: admiralov sopstveni prozor (localhost:3000) u tvom obicnom browseru se ne gasi automatski."
