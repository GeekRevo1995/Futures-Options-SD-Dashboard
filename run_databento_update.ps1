# run_databento_update.ps1 — Refresh the full snapshot layer with Databento.
# 1. fetch_databento_snapshot.py  (CME EOD chains -> trading_results CSVs)
# 2. update_dashboard.py          (CSVs -> docs/data JSONs + manifest)
# 3. live_feed.py                 (real-time overlay for the live feed)
param(
    [string]$Assets = 'GC ES NQ'
)

Set-Location -LiteralPath $PSScriptRoot
$ErrorActionPreference = 'Continue'

# Resolve a working python.exe regardless of PATH (Task Scheduler context).
if ($env:PYTHON_EXE -and (Test-Path $env:PYTHON_EXE)) {
    $Python = $env:PYTHON_EXE
} else {
    $Python = (Get-Command python.exe -ErrorAction SilentlyContinue).Source
    if (-not $Python) {
        $cand = Join-Path $env:LOCALAPPDATA 'Programs\Python\Python314\python.exe'
        if (Test-Path $cand) { $Python = $cand }
    }
}
if (-not $Python) {
    Write-Output '[ERROR] python.exe not found' | Add-Content -Path (Join-Path $PSScriptRoot 'logs\update.log')
    exit 1
}

$logDir = Join-Path $PSScriptRoot 'logs'
$logFile = Join-Path $logDir 'update.log'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
Start-Transcript -Path $logFile -Append

Write-Output "=== [$stamp] [1/3] Fetch Databento snapshot ==="
& $Python $PSScriptRoot\fetch_databento_snapshot.py @($Assets -split ' ')
Write-Output "`n=== [2/3] Update dashboard JSONs ==="
& $Python $PSScriptRoot\update_dashboard.py
Write-Output "`n=== [3/3] Live overlay ==="
& $Python $PSScriptRoot\live_feed.py
Write-Output "`nDone."

Stop-Transcript