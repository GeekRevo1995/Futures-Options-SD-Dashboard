@echo off
title Futures Options Dashboard Server :8051
cd /d "%~dp0"
echo Starting dashboard server on http://localhost:8051
python -m http.server 8051 --directory docs
pause