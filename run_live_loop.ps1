# run_live_loop.ps1 — Keep the REAL-TIME dashboard feed fresh.
# Runs live_feed.py in an infinite loop (logs to logs/live.log).
# Each cycle is watchdogged: a stalled python run (e.g. yfinance hang) is
# killed after CycleTimeoutSec so the loop never freezes.
# Stop with:  Get-CimInstance Win32_Process | ? { $_.CommandLine -match 'run_live_loop' } | ForEach { Stop-Process -Id $_.ProcessId -Force }
param(
    [int]$IntervalSec = 10,
    [int]$CycleTimeoutSec = 60
)

Set-Location -LiteralPath $PSScriptRoot
$ErrorActionPreference = 'Continue'
$logDir = Join-Path $PSScriptRoot 'logs'
$logFile = Join-Path $logDir 'live.log'
$liveScript = Join-Path $PSScriptRoot 'live_feed.py'
$outTmp = Join-Path $logDir ("_live_cycle_" + $PID + ".out")
$errTmp = Join-Path $logDir ("_live_cycle_" + $PID + ".err")
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

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
    Write-Output '[ERROR] python.exe not found' | Add-Content -Path $logFile
    exit 1
}

# Single-instance guard: refuse to start if another live loop powershell is alive
# (detects both full-path and 8.3 short-path launches, excluding ourselves).
$dupe = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -match 'run_live_loop|RUN_LI~1' }
if ($dupe) {
    Write-Output "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] another live loop is already running (pid $($dupe.ProcessId)); exiting." | Add-Content -Path $logFile
    Write-Output "Another live loop is already running (pid $($dupe.ProcessId)). This instance exits without starting."
    exit 0
}

Write-Output "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] live loop started (every ${IntervalSec}s, cycle timeout ${CycleTimeoutSec}s)" | Add-Content -Path $logFile

while ($true) {
    try {
        $proc = $null
        if (Test-Path $outTmp) { Remove-Item $outTmp -Force }
        if (Test-Path $errTmp) { Remove-Item $errTmp -Force }
        $proc = Start-Process -FilePath $Python -ArgumentList "`"$liveScript`"" -PassThru -WindowStyle Hidden `
            -RedirectStandardOutput $outTmp -RedirectStandardError $errTmp
        if (-not $proc.WaitForExit($CycleTimeoutSec * 1000)) {
            try { $proc.Kill() } catch { }
            Write-Output "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] cycle timeout >${CycleTimeoutSec}s, killed stuck python" | Add-Content -Path $logFile
        }
        if (Test-Path $outTmp) { Get-Content $outTmp | Add-Content -Path $logFile }
        if ((Test-Path $errTmp) -and (Get-Item $errTmp).Length -gt 0) {
            Get-Content $errTmp | Add-Content -Path $logFile
        }
        Remove-Item $outTmp, $errTmp -Force -ErrorAction SilentlyContinue
    } catch {
        Write-Output "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] error: $_" | Add-Content -Path $logFile
    }
    Start-Sleep -Seconds $IntervalSec
}