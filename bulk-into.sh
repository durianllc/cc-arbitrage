#!/usr/bin/env bash
# Upload every arb CSV into ONE existing collection, then export + analyze.
# Sidesteps the flaky "create collection" UI — you make the collection once by
# hand, this just selects it and uploads into it.
#
# SETUP (once, by hand in Card Ladder): create an EMPTY collection named ARBALL.
#
#   ./bulk-into.sh                 # uploads arb1..arb16 into "ARBALL"
#   ./bulk-into.sh MYCOLL 1 16     # custom collection name + range
#
# Each file uploads sequentially (full PSA budget = complete data). At the end it
# exports ARBALL once and runs the analyzer.

cd "$(dirname "$0")" || exit 1
COLL=${1:-ARBALL}
START=${2:-1}
END=${3:-16}

# Start clean: old per-file exports would double-count against ARBALL's export.
mkdir -p cert-upload/exports
rm -f cert-upload/exports/*.csv
pkill -9 -f browser-state-context 2>/dev/null
sleep 2

for n in $(seq "$START" "$END"); do
  f="cert-upload/arb${n}.csv"
  [ -f "$f" ] || { echo "skip: $f not found"; continue; }
  echo ""
  echo "============================================================"
  echo " uploading arb${n} into ${COLL}"
  echo "============================================================"
  NO_WAIT=1 node cl-bulk.mjs --into "$COLL" --no-export "$f"
  pkill -9 -f browser-state-context 2>/dev/null
  sleep 3
done

echo ""
echo "=== exporting ${COLL} ==="
NO_WAIT=1 node cl-bulk.mjs --export-only --collection "$COLL"
pkill -9 -f browser-state-context 2>/dev/null
sleep 2

echo ""
echo "=== analyzing + posting deals ==="
node analyze-exports.mjs
