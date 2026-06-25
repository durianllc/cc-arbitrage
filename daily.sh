#!/usr/bin/env bash
# DAILY re-check (Phase 2). Fast, no uploads, no PSA rate limit:
#   1. Scrape today's Collector Crypt prices (refresh mapping.json).
#   2. Export the Card Ladder collection(s) — gives today's fresh CL values
#      (Card Ladder re-values the already-loaded cards daily on its own).
#   3. Compare + post arbitrage deals to Discord.
#
# Prereq (Phase 1, done once): all certs loaded into the ARBALL collection.
#
#   ./daily.sh            # collection "ARBALL"
#   ./daily.sh MYCOLL     # custom collection name
#
# Schedule it (see README) to run every morning.

cd "$(dirname "$0")" || exit 1
COLL=${1:-ARBALL}

echo "=== $(date) — daily arbitrage re-check ==="

# 1. Fresh Collector Crypt prices (rewrites cert-upload/mapping.json).
echo "[1/3] Scraping Collector Crypt prices…"
node gen-cert-csvs.mjs || { echo "CC scrape failed"; exit 1; }

# 2. Fresh Card Ladder values — re-export the loaded collection (no PSA lookups).
echo "[2/3] Exporting Card Ladder collection '${COLL}'…"
pkill -9 -f browser-state-context 2>/dev/null; sleep 2
rm -f cert-upload/exports/*.csv
NO_WAIT=1 node cl-bulk.mjs --export-only --collection "$COLL" || { echo "CL export failed (logged in? collection exists?)"; exit 1; }
pkill -9 -f browser-state-context 2>/dev/null; sleep 2

# 3. Compare today's CC prices vs today's CL values → post deals to Discord.
echo "[3/3] Analyzing + posting deals…"
node analyze-exports.mjs

echo "=== done ==="
