#!/usr/bin/env bash
# Run cl-bulk.mjs over a range of arb CSVs back-to-back (hands-off), then analyze.
#
#   ./bulk-all.sh           # files arb3..arb16 (arb1, arb2 already done)
#   ./bulk-all.sh 1 16      # files arb1..arb16
#   ./bulk-all.sh 5 5       # just arb5
#
# Each file: create collection arbN -> upload -> wait -> export. Sequential
# (one browser at a time). At the end it runs analyze-exports.mjs once.

cd "$(dirname "$0")" || exit 1
START=${1:-3}
END=${2:-16}

# Make sure no stale browser is holding the profile.
pkill -9 -f browser-state-context 2>/dev/null
sleep 2

for n in $(seq "$START" "$END"); do
  f="cert-upload/arb${n}.csv"
  if [ ! -f "$f" ]; then echo "skip: $f not found"; continue; fi
  echo ""
  echo "============================================================"
  echo " arb${n}  ($f)"
  echo "============================================================"
  NO_WAIT=1 node cl-bulk.mjs "$f"
  # If a run leaves the profile locked, clear it before the next one.
  pkill -9 -f browser-state-context 2>/dev/null
  sleep 3
done

echo ""
echo "All uploads/exports done. Analyzing + posting deals to Discord…"
node analyze-exports.mjs
