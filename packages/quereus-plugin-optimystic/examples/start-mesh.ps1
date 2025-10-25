# Simple PowerShell script to start a 2-node Optimystic mesh for testing
# Usage: .\start-mesh.ps1

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host "🚀 Starting Optimystic Mesh Test Environment" -ForegroundColor Cyan
Write-Host ""

# Check if quoomb is installed
if (-not (Get-Command quoomb -ErrorAction SilentlyContinue)) {
    Write-Host "❌ Error: quoomb is not installed" -ForegroundColor Red
    Write-Host "Install with: npm install -g @quereus/quoomb-cli"
    exit 1
}

# Start node 1 in background
Write-Host "📡 Starting Node 1 (port 8011)..." -ForegroundColor Yellow
$Node1Config = Join-Path $ScriptDir "quoomb.config.node1.json"
$Node1LogFile = Join-Path $env:TEMP "quoomb-node1.log"

$Node1Process = Start-Process -FilePath "quoomb" `
    -ArgumentList "--config", $Node1Config `
    -RedirectStandardOutput $Node1LogFile `
    -RedirectStandardError $Node1LogFile `
    -PassThru `
    -NoNewWindow

# Wait for node 1 to start
Write-Host "⏳ Waiting for Node 1 to start..." -ForegroundColor Yellow
Start-Sleep -Seconds 3

Write-Host ""
Write-Host "✅ Node 1 started (PID: $($Node1Process.Id))" -ForegroundColor Green
Write-Host ""
Write-Host "📋 Next steps:" -ForegroundColor Cyan
Write-Host "1. Check Node 1 log: Get-Content $Node1LogFile -Wait"
Write-Host "2. Find the listening multiaddr (e.g., /ip4/127.0.0.1/tcp/8011/p2p/12D3KooW...)"
Write-Host "3. Edit quoomb.config.node2.json and replace REPLACE_WITH_NODE1_MULTIADDR"
Write-Host "4. Start Node 2: quoomb --config quoomb.config.node2.json"
Write-Host ""
Write-Host "Or use environment variable:" -ForegroundColor Cyan
Write-Host '  $env:BOOTSTRAP_ADDR="<multiaddr>"; quoomb --config quoomb.config.node2.env.json'
Write-Host ""
Write-Host "To stop Node 1: Stop-Process -Id $($Node1Process.Id)" -ForegroundColor Yellow
Write-Host ""

