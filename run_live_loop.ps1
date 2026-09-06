# run_live_loop.ps1 — Keep the REAL-TIME dashboard feed fresh.
# Runs live_feed.py in an infinite loop (logs to logs/live.log).
# Stop with:  Stop-Process -Name powershell | then taskkill /F /FI "WINDOWTITLE eq livefeed*"
param(
    [int]$IntervalSec = 10
)

Set-Location -LiteralPath $PSScriptRoot
$ErrorActionPreference = 'Continue'
$logDir = Join-Path $PSScriptRoot 'logs'
$logFile = Join-Path $logDir 'live.log'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

Write-Output "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] live loop started (every ${IntervalSec}s)" | Add-Content -Path $logFile

while ($true) {
    try {
        & python $PSScriptRoot\live_feed.py 2>&1 | Out-String | Add-Content -Path $logFile
    } catch {
        Write-Output "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] error: $_" | Add-Content -Path $logFile
    }
    Start-Sleep -Seconds $IntervalSec
}