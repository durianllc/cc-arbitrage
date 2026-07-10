@echo off
REM 24/7 Collector Crypt monitor for Windows. Double-click to start the 15-min loop.
cd /d "%~dp0"
echo Starting cc-arbitrage monitor loop (every 15 min). Close this window to stop.
echo.
node monitor-loop.mjs
echo.
echo Monitor loop stopped.
pause
