$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

Write-Host "=== KASNJENJE install ==="

try {
  $nodeVersion = node -v
  Write-Host "Node:" $nodeVersion
} catch {
  Write-Error "Node.js nije instaliran ili nije u PATH-u."
  exit 1
}

npm install
if ($LASTEXITCODE -ne 0) {
  Write-Error "npm install nije uspeo."
  exit $LASTEXITCODE
}

Write-Host "Install OK"
