# start-dashboard.ps1 — Restart everything after a reboot (server + live loop).
# Registered as a Windows logon task (FuturesDashboard_Autostart).
# Optional: -Refresh runs one full snapshot refresh (costs small Databento credits).

param(
    [switch]$Refresh
)

Set-Location -LiteralPath $PSScriptRoot

if ($env:PYTHON_EXE -and (Test-Path $env:PYTHON_EXE)) {
    $Python = $env:PYTHON_EXE
} else {
    $Python = (Get-Command python.exe -ErrorAction SilentlyContinue).Source
    if (-not $Python) {
        $cand = Join-Path $env:LOCALAPPDATA 'Programs\Python\Python314\python.exe'
        if (Test-Path $cand) { $Python = $cand }
    }
}
if (-not $Python) { Write-Output '[ERROR] python.exe not found'; exit 1 }

# 8.3 short paths avoid PowerShell 5.1 Start-Process splitting spaced args.
$fso = New-Object -ComObject Scripting.FileSystemObject
function ShortPathOf([string]$p) {
    if ([IO.Path]::HasExtension($p)) { return $fso.GetFile($p).ShortPath }
    return $fso.GetFolder($p).ShortPath
}
$loopScript = ShortPathOf (Join-Path $PSScriptRoot 'run_live_loop.ps1')
$liveFeed = ShortPathOf (Join-Path $PSScriptRoot 'live_feed.py')

$logDir = Join-Path $PSScriptRoot 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logFile = Join-Path $logDir 'startup.log'
Write-Output "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] start-dashboard" | Add-Content -Path $logFile

# 1. Static web server on 8051 (8050 is occupied by the Docker container)
$serverUp = (Get-NetTCPConnection -LocalPort 8051 -State Listen -ErrorAction SilentlyContinue) -ne $null
if ($serverUp) {
    Write-Output "  server: already running on :8051" | Add-Content -Path $logFile
} else {
    $p = Start-Process -FilePath $Python -ArgumentList '-m','http.server','8051','--directory','docs' -WindowStyle Hidden -PassThru
    Write-Output "  server: started on :8051 (pid $($p.Id))" | Add-Content -Path $logFile
}

# 2. Live feed loop (every 10s)
$loopRunning = (Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
                Where-Object { $_.CommandLine -like '*run_live_loop.ps1*' })
if ($loopRunning) {
    Write-Output "  live loop: already running (pid $($loopRunning.ProcessId))" | Add-Content -Path $logFile
} else {
    $p = Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',$loopScript -WindowStyle Hidden -PassThru
    Write-Output "  live loop: started (pid $($p.Id))" | Add-Content -Path $logFile
    Start-Sleep -Seconds 20
    $p = Start-Process -FilePath $Python -ArgumentList $liveFeed -WindowStyle Hidden -Wait
}

# 3. Optional one-shot snapshot refresh (weekly task also covers this)
if ($Refresh) {
    Write-Output "  refresh requested: running full snapshot" | Add-Content -Path $logFile
    Start-Process -FilePath $Python -ArgumentList (ShortPathOf (Join-Path $PSScriptRoot 'fetch_databento_snapshot.py')),'GC','ES','NQ' -NoNewWindow -Wait
    Start-Process -FilePath $Python -ArgumentList (ShortPathOf (Join-Path $PSScriptRoot 'update_dashboard.py')) -NoNewWindow -Wait
}

Write-Output "  done." | Add-Content -Path $logFile