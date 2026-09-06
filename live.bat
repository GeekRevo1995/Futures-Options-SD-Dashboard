@echo off
title Futures Options Live Feed Loop
cd /d "%~dp0"
echo Real-time feed loop (Ctrl+C to stop)...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run_live_loop.ps1"
pause