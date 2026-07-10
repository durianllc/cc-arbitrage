#!/usr/bin/env bash
# Run the monitor every 15 minutes. Keep this terminal open (or use launchd).
#   ./monitor-loop.sh
#   caffeinate -dimsu ./monitor-loop.sh     # also keep the Mac awake
cd "$(dirname "$0")" || exit 1
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:$PATH"

while true; do
  pkill -9 -f browser-state-context 2>/dev/null; sleep 1
  node monitor.mjs
  echo "--- sleeping 15 min ($(date)) ---"
  sleep 900
done
