$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host "=== MITI install ==="

try {
  $nodeVersion = node -v
  Write-Host "Node:" $nodeVersion
} catch {
  Write-Error "Node.js nije instaliran ili nije u PATH-u."
  exit 1
}

Set-Location $root
npm install
if ($LASTEXITCODE -ne 0) {
  Write-Error "npm install nije uspeo u MITI root."
  exit $LASTEXITCODE
}

Set-Location (Join-Path $root "esoccer-skupljac")
npm install
if ($LASTEXITCODE -ne 0) {
  Write-Error "npm install nije uspeo u esoccer-skupljac."
  exit $LASTEXITCODE
}

# Playwright browser (obavezno za 4001 / esoccer-skupljac)
Write-Host "Instaliram Playwright Chromium (potrebno za 4001)..."
npx playwright install chromium
if ($LASTEXITCODE -ne 0) {
  Write-Error "npx playwright install chromium nije uspeo."
  exit $LASTEXITCODE
}

Write-Host "Install OK"
