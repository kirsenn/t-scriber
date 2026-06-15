#!/usr/bin/env bash
# Measure Electron UI idle CPU/RAM.
# Usage: bash scripts/measure-ui.sh [results-dir [duration-seconds]]
#
# Starts the Electron app, waits for it to initialise, samples for DURATION
# seconds, then quits the app and prints stats. All Electron renderer + GPU
# helper processes are included in the totals.
set -euo pipefail

RESULTS_DIR="${1:-/tmp/tscriber-bench}"
DURATION="${2:-30}"
mkdir -p "$RESULTS_DIR"

CSV="$RESULTS_DIR/ui-procs.csv"
SUMMARY="$RESULTS_DIR/ui-summary.txt"

echo "timestamp_s,name,pid,cpu_pct,rss_mb" > "$CSV"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/../electron"

# ── start Electron ────────────────────────────────────────────────────────────
echo "=== Electron UI idle measurement (${DURATION}s) ==="
npm start &>/dev/null &
NPM_PID=$!

# Kill the whole process group on exit
trap 'kill -- -"$(ps -o pgid= -p "$NPM_PID" 2>/dev/null | tr -d " ")" 2>/dev/null
      pkill -f "Electron Helper\|electron \." 2>/dev/null || true' EXIT INT TERM

echo "Starting Electron (PID $NPM_PID), waiting 8s for init..."
sleep 8

# ── sample loop ───────────────────────────────────────────────────────────────
echo "Sampling for ${DURATION}s..."
END_TS=$(( $(date +%s) + DURATION ))
while [ "$(date +%s)" -lt "$END_TS" ]; do
  ts=$(date +%s)
  ps aux | awk -v ts="$ts" '
    /[E]lectron|[e]lectron \.|[E]lectron Helper/ {
      name = $11; sub(".*/", "", name)
      printf "%d,%s,%s,%s,%.1f\n", ts, name, $2, $3, $6/1024
    }
  ' >> "$CSV"
  sleep 2
done

# ── summarise ─────────────────────────────────────────────────────────────────
echo ""
echo "=== Electron idle resource usage ===" | tee "$SUMMARY"
echo "" | tee -a "$SUMMARY"

awk -F, 'NR==1{next}
{
  cpu=$4+0; rss=$5+0
  if (cpu > max_cpu) max_cpu=cpu
  if (rss > max_rss) max_rss=rss
  sum_rss+=rss; sum_cpu+=cpu; cnt++
  # sum all processes per timestamp for total RSS
  ts=$1; ts_rss[ts]+=rss
}
END {
  peak_total=0
  for (ts in ts_rss) if (ts_rss[ts]>peak_total) peak_total=ts_rss[ts]

  avg_cpu = (cnt>0 ? sum_cpu/cnt : 0)
  avg_rss = (cnt>0 ? sum_rss/cnt : 0)

  printf "Peak CPU (any single process): %.1f%%\n", max_cpu
  printf "Peak RAM (any single process): %.0f MB\n", max_rss
  printf "Avg  CPU (any single process): %.1f%%\n", avg_cpu
  printf "Avg  RAM (any single process): %.0f MB\n", avg_rss
  printf "\n"
  printf "Peak RAM (all processes sum):  %.0f MB\n", peak_total
}' "$CSV" | tee -a "$SUMMARY"

echo ""
echo "CSV    : $CSV"
echo "Summary: $SUMMARY"
