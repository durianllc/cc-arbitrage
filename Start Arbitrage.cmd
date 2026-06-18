@echo off
echo Starting CC Arbitrage...
echo This will scrape Collector Crypt and look up Card Ladder values.
echo Results will be saved to results.csv and BUY hits posted to Discord.
echo.
echo To stop at any time press Ctrl+C — progress is saved and will resume on next run.
echo.
node run.mjs --concurrency 6
echo.
pause
