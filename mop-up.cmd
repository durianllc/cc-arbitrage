@echo off
REM Run one fast pass, then several gentle mop-up passes.
REM Each re-run only retries certs still cached with no value (clValue: null),
REM so this converges on the cards a rate-limit caused us to miss.
REM Assumes the missing certs really exist on Card Ladder; cards genuinely
REM absent from CL will fail every pass, which is why this is capped at 5 passes.

echo === Pass 1: fast, 5 tabs ===
call node run.mjs --concurrency 5

for /L %%i in (2,1,5) do (
  echo === Mop-up pass %%i: gentle, 2 tabs, longer delay ===
  call node run.mjs --concurrency 2 --delay 2000 --retries 3
  timeout /t 30 >nul
)

echo Done. Check results.csv
